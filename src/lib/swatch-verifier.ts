import { analyzeWithProModel } from '@/lib/gemini/client';

export interface VerificationResult {
  pass: boolean;
  score: number;        // 0-1 fidelity score
  issues: string[];     // specific problems found
  feedback: string;     // one-line summary for retry prompt
  // Sub-scores from Gemini 2.5 Pro — persisted so we can diagnose jobs
  // post-hoc by knowing WHY the verifier passed or failed.
  // composition_preserved is kept optional so older job rows that have it
  // populated still parse, but new runs no longer set it (hero dropped from
  // the verifier call to avoid swatch/hero confusion — see verifySwatch).
  checks?: {
    pattern_match: number;
    color_match: number;
    texture_match: number;
    composition_preserved?: number;
    no_invention: number;
    scale_correct: number;
    orientation_correct: number;
  };
  rawResponse?: string; // The full Gemini text response for audit
}

// H7 audit: categories where pattern scale is critical (tile_swatch=true in
// strategy). For these, scale_correct = 0 becomes a hard blocker even if the
// overall score is high — a miniaturized or oversized pattern on a pillowcase
// or quilt body is a product defect even if colors and motifs match.
// Research context: `research/2026-04-14-...:225` lists "problemas de escala de
// patrones" as one of the 6 textile failure modes, and the density rule in
// `category-strategy.ts` for quilts explicitly forbids scale mismatch.
const SCALE_CRITICAL_CATEGORIES = new Set(['quilts', 'cubrecamas', 'plumones']);

/**
 * Uses Gemini 2.5 Pro to verify that the generated image faithfully
 * reproduces the swatch pattern. Runs AFTER generation, BEFORE QA.
 *
 * Compares: swatch (Image 1) vs generated output (Image 2)
 * Returns pass/fail + specific issues for retry if failed.
 */
export async function verifySwatch(
  swatchBase64: string,
  generatedBase64: string,
  _heroBase64: string,
  swatchName: string,
  patternDescription?: string | null,
  category?: string | null,
): Promise<VerificationResult | null> {
  // Hero deliberately NOT sent to the verifier. Repro: job 3d109a78 (frazada
  // Rosa swatch + light-blue flannel hero, both ribbed flannel) — the
  // verifier confused the hero with the swatch and reported "swatch is light
  // blue, ribs vertical" describing the hero's properties. Composition
  // checks are not a blocker anyway, so dropping the hero removes a
  // confusion source without losing a guard.
  const prompt = `You are a quality inspector for textile product photography. Compare these 2 images:

IMAGE 1: The SWATCH — this is the REFERENCE. The generated image MUST match this fabric exactly (color, pattern, texture, scale, orientation).
IMAGE 2: The GENERATED IMAGE — this is what we need to verify.

Your job: Does Image 2 faithfully reproduce the fabric of Image 1? Look ONLY at these two images. Do not infer anything from outside them.
${patternDescription ? `\nExpected pattern: "${patternDescription}"` : ''}

CHECK EACH of these and score 0 (fail) or 1 (pass):

1. PATTERN_MATCH: Are the design elements (flowers, shapes, motifs) the SAME as Image 1? Not similar — SAME shapes, same style.
2. COLOR_MATCH: Do the colors of the fabric match Image 1 exactly? Same hue, same warmth, same saturation. If Image 2 contains zones of a clearly different color (e.g. a blue patch where Image 1 is taupe), this check FAILS.
3. TEXTURE_MATCH: If Image 1 shows quilted/textured fabric, does Image 2 show the same texture?
4. NO_INVENTION: Is Image 2 free of INVENTED fabric patterns or designs not in Image 1? IGNORE any logo/watermark in the corners — logos are added automatically in post-processing and should NOT be penalized.
5. SCALE_CORRECT: Are the pattern motifs the same relative size as in Image 1?
6. ORIENTATION_CORRECT: Are stripes, lines, ribs, and pattern elements oriented the same way as in Image 1? Horizontal stays horizontal, vertical stays vertical. This is CRITICAL.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "pattern_match": 0 or 1,
  "color_match": 0 or 1,
  "texture_match": 0 or 1,
  "no_invention": 0 or 1,
  "scale_correct": 0 or 1,
  "orientation_correct": 0 or 1,
  "overall_score": 0.0 to 1.0,
  "issues": ["issue 1", "issue 2"],
  "feedback": "one sentence describing the main problem, or 'Faithful reproduction'"
}`;

  try {
    const result = await analyzeWithProModel({
      images: [
        { base64: swatchBase64, mimeType: 'image/png' },
        { base64: generatedBase64, mimeType: 'image/png' },
      ],
      promptText: prompt,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[swatch-verifier] Pro model failed:', result.error);
      return null;
    }

    // Parse JSON from response (handle markdown code blocks)
    const text = result.textResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    const score = typeof parsed.overall_score === 'number' ? parsed.overall_score : 0.5;
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    let feedback = parsed.feedback || 'Unknown';

    const checks = {
      pattern_match: Number(parsed.pattern_match ?? 0),
      color_match: Number(parsed.color_match ?? 0),
      texture_match: Number(parsed.texture_match ?? 0),
      no_invention: Number(parsed.no_invention ?? 0),
      scale_correct: Number(parsed.scale_correct ?? 0),
      orientation_correct: Number(parsed.orientation_correct ?? 0),
    };

    // Base blockers: color + pattern + invention + orientation. Color is a
    // hard blocker because BANVA products are sold by color variant — a quilt
    // listed as "Arena" that ships looking blue is a refund, not a tolerable
    // drift. Repro: job 65706cda passed with score 0.71 despite the verifier
    // explicitly flagging "light blue instead of cream" because color_match
    // wasn't in the blocker set. Orientation is critical for directional
    // patterns; undefined means the verifier didn't opine.
    const baseBlockersPass =
      score >= 0.7 &&
      parsed.pattern_match === 1 &&
      parsed.color_match === 1 &&
      parsed.no_invention === 1 &&
      (parsed.orientation_correct === 1 || parsed.orientation_correct === undefined);

    // H7: scale_correct is a hard blocker for tile-prone categories (quilts,
    // cubrecamas, plumones) where pattern scale mismatch is a product defect.
    // For other categories (towels, sheets, curtains), scale stays non-blocking
    // since the strategy already scopes tile_swatch to bed-covers only.
    const categoryKey = (category || '').toLowerCase();
    const scaleBlocker = SCALE_CRITICAL_CATEGORIES.has(categoryKey) && checks.scale_correct === 0;
    const pass = baseBlockersPass && !scaleBlocker;

    if (scaleBlocker) {
      const scaleIssue = `Pattern scale mismatch on ${categoryKey} — motifs are wrong size vs swatch`;
      if (!issues.includes(scaleIssue)) issues.push(scaleIssue);
      if (feedback === 'Faithful reproduction' || feedback === 'Faithful reproduction.') {
        feedback = scaleIssue;
      }
    }

    console.log(`[swatch-verifier] "${swatchName}" (${categoryKey || 'no-cat'}): score=${score}, pass=${pass}, scale_blocker=${scaleBlocker}, issues=${issues.length} | pattern=${checks.pattern_match} color=${checks.color_match} texture=${checks.texture_match} noInvention=${checks.no_invention} scale=${checks.scale_correct} orientation=${checks.orientation_correct}`);

    return { pass, score, issues, feedback, checks, rawResponse: result.textResponse };
  } catch (err) {
    console.error('[swatch-verifier] Error:', err);
    return null;
  }
}

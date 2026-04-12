import { analyzeWithProModel } from '@/lib/gemini/client';

export interface VerificationResult {
  pass: boolean;
  score: number;        // 0-1 fidelity score
  issues: string[];     // specific problems found
  feedback: string;     // one-line summary for retry prompt
  // Sub-scores from Gemini 2.5 Pro — persisted so we can diagnose jobs
  // post-hoc by knowing WHY the verifier passed or failed.
  checks?: {
    pattern_match: number;
    color_match: number;
    texture_match: number;
    composition_preserved: number;
    no_invention: number;
    scale_correct: number;
    orientation_correct: number;
  };
  rawResponse?: string; // The full Gemini text response for audit
}

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
  heroBase64: string,
  swatchName: string,
  patternDescription?: string | null,
): Promise<VerificationResult | null> {
  const prompt = `You are a quality inspector for textile product photography. Compare these 3 images:

IMAGE 1: The SWATCH — this is the REFERENCE. The generated image MUST match this pattern exactly.
IMAGE 2: The GENERATED IMAGE — this is what we need to verify.
IMAGE 3: The HERO — the original composition reference (angle, scene, layout).

Your job: Does Image 2 faithfully reproduce the fabric pattern from Image 1?
${patternDescription ? `\nExpected pattern: "${patternDescription}"` : ''}

CHECK EACH of these and score 0 (fail) or 1 (pass):

1. PATTERN_MATCH: Are the design elements (flowers, shapes, motifs) the SAME as Image 1? Not similar — SAME shapes, same style.
2. COLOR_MATCH: Do the colors match Image 1 exactly? Same hue, same warmth, same saturation.
3. TEXTURE_MATCH: If Image 1 shows quilted/textured fabric, does Image 2 show the same texture?
4. COMPOSITION_PRESERVED: Does Image 2 keep the same camera angle, scene layout, and framing as Image 3 (hero)?
5. NO_INVENTION: Is Image 2 free of INVENTED fabric patterns or designs not in Image 1? IGNORE any logo/watermark in the corners — logos are added automatically in post-processing and should NOT be penalized.
6. SCALE_CORRECT: Are the pattern motifs the same relative size as in Image 1?
7. ORIENTATION_CORRECT: Are stripes, lines, and pattern elements oriented the same way as in Image 1? Horizontal stripes must stay horizontal, vertical must stay vertical. This is CRITICAL.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "pattern_match": 0 or 1,
  "color_match": 0 or 1,
  "texture_match": 0 or 1,
  "composition_preserved": 0 or 1,
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
        { base64: heroBase64, mimeType: 'image/png' },
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
    const feedback = parsed.feedback || 'Unknown';
    const pass = score >= 0.7 && parsed.pattern_match === 1 && parsed.no_invention === 1 && (parsed.orientation_correct === 1 || parsed.orientation_correct === undefined);

    const checks = {
      pattern_match: Number(parsed.pattern_match ?? 0),
      color_match: Number(parsed.color_match ?? 0),
      texture_match: Number(parsed.texture_match ?? 0),
      composition_preserved: Number(parsed.composition_preserved ?? 0),
      no_invention: Number(parsed.no_invention ?? 0),
      scale_correct: Number(parsed.scale_correct ?? 0),
      orientation_correct: Number(parsed.orientation_correct ?? 0),
    };

    console.log(`[swatch-verifier] "${swatchName}": score=${score}, pass=${pass}, issues=${issues.length} | pattern=${checks.pattern_match} color=${checks.color_match} texture=${checks.texture_match} composition=${checks.composition_preserved} noInvention=${checks.no_invention} scale=${checks.scale_correct} orientation=${checks.orientation_correct}`);

    return { pass, score, issues, feedback, checks, rawResponse: result.textResponse };
  } catch (err) {
    console.error('[swatch-verifier] Error:', err);
    return null;
  }
}

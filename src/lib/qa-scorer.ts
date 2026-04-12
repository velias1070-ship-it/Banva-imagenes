// ─────────────────────────────────────────────────────────────────────────────
// QA Scorer — Evaluates generated images against swatch + hero using Gemini
// ─────────────────────────────────────────────────────────────────────────────
// Sends 3 images (generated + swatch + hero) to Gemini for text-only analysis.
// Returns 8-dimensional QADetail scores + feedback + action recommendation.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeImages } from '@/lib/gemini/client';
import { computeWeightedScore, determineAction, type QAAction } from '@/lib/qa-criteria';
import type { QADetail } from '@/types/database';
import type { CategoryStrategy } from '@/lib/category-strategy';
import type { ProjectSettings } from '@/lib/project-settings';
import type { BrandConfig } from '@/lib/brand';

export interface ScoreImageRequest {
  generatedBase64: string;
  generatedMimeType?: string;
  swatchBase64: string;
  swatchMimeType?: string;
  heroBase64: string;       // ALWAYS present — even for from_scratch, hero is the composition reference
  heroMimeType?: string;
  category: string;
  swatchName: string;
  swatchHex?: string | null; // Dominant swatch color hex for color accuracy anchoring
  strategy: CategoryStrategy;
  attempt: number;
  projectSettings?: ProjectSettings; // Per-project QA overrides
  actualMode?: string; // The actual generation mode used (from prompt_metadata.strategy), falls back to strategy.generation_mode
  brand?: BrandConfig | null; // Brand config for brand compliance scoring
  shotType?: string; // Shot type (lifestyle, main, detail, infografia, etc.) — changes QA rules
}

export interface ScoreImageResult {
  score: number;
  detail: QADetail;
  feedback: string;
  action: QAAction;
  durationMs: number;
  reasons?: Record<string, string>; // Per-dimension reasoning from Gemini
  rawResponse?: string;             // Full Gemini text response for audit
}

// ─────────────────────────────────────────────────────────────────────────────
// Build QA prompt for Gemini analysis
// ─────────────────────────────────────────────────────────────────────────────

function buildQAPrompt(
  strategy: CategoryStrategy,
  swatchName: string,
  generationMode: string,
  swatchHex?: string | null,
  brand?: BrandConfig | null,
  shotType?: string
): string {
  const focusAreas = strategy.qa_focus_areas?.length
    ? `\nCATEGORY-SPECIFIC FOCUS AREAS:\n${strategy.qa_focus_areas.map((a) => `* ${a}`).join('\n')}`
    : '';

  const learningsBlock = strategy.learnings?.length
    ? `\n\nMANDATORY REJECTION RULES (learned from past failures — these are HARD REQUIREMENTS):\n${strategy.learnings.map((l) => `* REJECT IF: ${l}`).join('\n')}\nIf ANY of these rules are violated, set product_fidelity to 0.3 or lower.`
    : '';

  // Infografia shots legitimately have text, logos, and comparison layouts as
  // part of the hero design. The default "text overlay = bad" rule must be
  // inverted for these — text IS the content. BUT the text MUST be in Spanish
  // (mercado Chile) — if the hero was an English template, the output should
  // have translated it.
  const isInfografia = shotType === 'infografia';
  const textCheck = isInfografia
    ? `CONTEXT — INFOGRAFIA SHOT: The hero (Image 3) is a marketing infographic with text, logos, icons, checkmarks, and a comparison layout. That text content IS PART OF THE HERO and MUST appear preserved in the generated image — do NOT penalize text preservation. HOWEVER, every visible text element MUST be in Spanish (target market: Chile). If Image 1 contains ANY visible English text (e.g. "Bedsure", "Ultrasonic Binding", "No stitches", "Unraveling", "Pet-unfriendly"), score ml_compliance = 0.0-0.2 — this is a translation failure. If text is in Spanish and matches the hero layout, score ml_compliance = 1.0. Also: if the left side brand name is a competitor (e.g. "Bedsure") instead of "Banva Home", score brand_compliance = 0.0-0.3.`
    : `CRITICAL CHECK: Compare text content between Image 1 (generated) and Image 3 (hero). If Image 1 has text overlays (like size labels, piece counts, brand names) that do NOT exist in Image 3, this is a generation error — score ml_compliance very low (0.0-0.2).`;

  return `You are a quality assurance expert for e-commerce product photography. Your job is to evaluate a generated image against its reference materials.

You are given 3 images:
- IMAGE 1: The GENERATED product image (to be evaluated)
- IMAGE 2: The SWATCH REFERENCE — this IS the correct fabric (color, pattern, texture, quilting). The ONLY source of truth for what the fabric should look like. The swatch is labeled "${swatchName}" but treat that label as a COLOR NAME / VARIANT CODE ONLY — do NOT infer fabric type, material, or pattern from the label. For example, a swatch labeled "Denim" may show a floral print — the "Denim" is just the color variant name, not an instruction that the fabric is denim material. Judge ONLY by what Image 2 actually shows.
- IMAGE 3: The HERO/COMPOSITION REFERENCE — this shows the DESIRED composition, camera angle, and scene layout

The generation mode was: ${generationMode}
Product category: ${strategy.label}
Shot type: ${shotType || 'unknown'}

${textCheck}

EVALUATE Image 1 across these 8 dimensions. Score each from 0.0 to 1.0:

1. **product_fidelity** (0-1): Does Image 1's textile product EXACTLY match Image 2's fabric?
   - Same color/hue? Same pattern/design? Same texture/stitch?
   - If the product's pattern was INVENTED (not from swatch) → score 0.0-0.2
   - If the color is wrong → score 0.2-0.4
   - If minor deviations → 0.6-0.8
   - If exact match → 0.9-1.0

2. **color_accuracy** (0-1): How accurately does Image 1 reproduce Image 2's EXACT color temperature and hue?
   ${swatchHex ? `REFERENCE HEX: The swatch dominant color is approximately ${swatchHex}. Use this as an anchor.` : ''}
   - Exact hue + saturation + brightness + warmth/coolness match → 0.9-1.0
   - Very minor, barely noticeable shift → 0.7-0.9
   - COLOR TEMPERATURE SHIFT detected (white→cream, cool→warm, warm→cool) → 0.2-0.4
   - Clearly wrong color → 0.0-0.2
   CRITICAL COLOR RULES:
   - White fabric that looks cream or beige = COLOR TEMPERATURE SHIFT → score 0.3 max
   - Cool-toned fabric that looks warm = COLOR TEMPERATURE SHIFT → score 0.3 max
   - Warm-toned fabric that looks cool = COLOR TEMPERATURE SHIFT → score 0.3 max
   - Look CAREFULLY at the swatch (Image 2) base color vs the generated fabric (Image 1) base color

3. **composition_match** (0-1): Does Image 1 match Image 3's composition?
   - Same camera angle? Same product placement? Same number of items?
   - For ${generationMode === 'from_scratch' ? 'from_scratch mode, evaluate if the composition is commercially appropriate (not identical to Image 3)' : 'edit/reference mode, it should closely match Image 3'}
   - Score 0.0-0.3 if the camera angle, scene layout, or room environment came from Image 2 (swatch) instead of Image 3 (hero). This is called 'composition leak'. Compare the background, furniture, wall decorations, and camera angle — they must match Image 3, NOT Image 2.
   ${isInfografia ? `- INFOGRAFIA CLOSEUP LOCK: the hero's left side is a FLAT CLOSEUP of fabric texture. Score 0.0-0.3 if the generated image's left side shows a bed, headboard, pillows, bedroom scene, furniture, windows, or any room composition instead of a flat fabric closeup. The fabric texture must FILL the left half as a closeup — no beds, no rooms.` : ''}

4. **visual_quality** (0-1): Professional photography quality?
   - Sharp focus, natural lighting, realistic textures → 1.0
   - Artifacts, blur, unnatural elements → lower

5. **resolution** (0-1): Is the image sharp and detailed enough for e-commerce?
   - Clear, crisp details → 1.0
   - Blurry or low-res → lower

6. **aspect_ratio** (0-1): Is the image properly framed?
   - Product well-centered, appropriate margins → 1.0
   - Badly cropped or awkward framing → lower

7. **ml_compliance** (0-1): Is this suitable for MercadoLibre?
   - No watermarks, no unwanted text, no unwanted logos → 1.0
   ${isInfografia ? `- INFOGRAFIA SHOT: the hero is a comparison infographic with text, logo, checkmarks, and layout. Preservation of hero text is REQUIRED — do NOT penalize for it.
   - LANGUAGE CHECK (mercado Chile requirement): every visible text element in Image 1 MUST be in Spanish. If Image 1 contains English text — "Bedsure", "Others", "Ultrasonic", "stitches", "slippage", "filling", "Unraveling", "Stiffer", "Pet-unfriendly", etc. — score ml_compliance = 0.0-0.2. If every text element is in Spanish, score ml_compliance = 1.0.
   - BRAND NAME CHECK: the left side of the comparison must show "Banva Home" (or no brand) as the product name. If it shows a competitor name like "Bedsure", this is a brand failure — score ml_compliance = 0.0-0.2 AND brand_compliance = 0.0-0.3.`
   : `- Contains unwanted text/watermarks → lower
   - Score 0.0-0.2 if the generated image contains ANY text overlay that does NOT exist in Image 3 (hero). Common failure: Gemini adds '1.5 Plazas', 'Set 3 Piezas', size labels, or brand names. If Image 3 has no text overlays but the generated image does, this is a CRITICAL failure.
   - Score 0.0-0.2 if the generated image contains a logo or brand name that was GENERATED by AI (not overlaid in post-process). Look for 'BANVA', 'HOME', or any brand text rendered as part of the image content.`}

8. **hero_contamination** (0-1): Did Image 3's ORIGINAL fabric pattern bleed into Image 1?
   - 0.0 = CLEAN — Image 1's fabric comes entirely from Image 2 (swatch)
   - 0.5 = PARTIAL — some elements from Image 3's fabric visible
   - 1.0 = FULL — Image 1 looks like Image 3 with no fabric change
   - This measures whether the generation FAILED to replace the original textile
${brand ? `
9. **brand_compliance** (0-1): ONLY score this if brand information is provided below.
   - Are the text colors in the generated image consistent with the brand colors specified?
   - 1.0 = text colors match brand specification
   - 0.5 = some text colors match, some don't
   - 0.0 = text colors completely wrong or ignored
   If no brand information is provided, score 1.0 (not applicable).` : ''}
${focusAreas}${learningsBlock}
${brand ? `
BRAND INFORMATION:
Expected text colors:
  - Titles: ${brand.primary_color}
  - Subtitles: ${brand.secondary_color}
  - Features/highlights: ${brand.accent_color}` : ''}

RESPOND WITH ONLY a valid JSON object (no markdown, no backticks, no explanation before or after). Each score has a companion "_reason" field with a short explanation of what you observed — these reasons are saved to the database for post-hoc debugging of why a score was given:
{
  "product_fidelity": <number>,
  "product_fidelity_reason": "<short sentence describing what you saw>",
  "color_accuracy": <number>,
  "color_accuracy_reason": "<short sentence>",
  "composition_match": <number>,
  "composition_match_reason": "<short sentence about framing, camera angle, room, objects, people/animals positions>",
  "visual_quality": <number>,
  "visual_quality_reason": "<short sentence>",
  "resolution": <number>,
  "aspect_ratio": <number>,
  "ml_compliance": <number>,
  "ml_compliance_reason": "<short sentence — mention text language, unwanted text overlays, logos>",
  "hero_contamination": <number>,
  "hero_contamination_reason": "<short sentence>",${brand ? '\n  "brand_compliance": <number>,\n  "brand_compliance_reason": "<short sentence>",' : ''}
  "feedback": "<one sentence explaining the most critical issue, or 'Excellent quality' if all good>"
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse Gemini's QA response into structured data
// ─────────────────────────────────────────────────────────────────────────────

function parseQAResponse(text: string): { detail: QADetail; feedback: string; reasons: Record<string, string>; rawResponse: string } | null {
  try {
    // Try to extract JSON from the response (handle potential markdown wrapping)
    let jsonStr = text.trim();

    // Remove markdown code block if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate all required fields
    const requiredFields = [
      'product_fidelity', 'color_accuracy', 'composition_match',
      'visual_quality', 'resolution', 'aspect_ratio',
      'ml_compliance', 'hero_contamination',
    ];

    for (const field of requiredFields) {
      if (typeof parsed[field] !== 'number' || parsed[field] < 0 || parsed[field] > 1) {
        console.error(`[qa-scorer] Invalid field ${field}: ${parsed[field]}`);
        return null;
      }
    }

    const detail: QADetail = {
      product_fidelity: parsed.product_fidelity,
      color_accuracy: parsed.color_accuracy,
      composition_match: parsed.composition_match,
      visual_quality: parsed.visual_quality,
      resolution: parsed.resolution,
      aspect_ratio: parsed.aspect_ratio,
      ml_compliance: parsed.ml_compliance,
      hero_contamination: parsed.hero_contamination,
      brand_compliance: typeof parsed.brand_compliance === 'number' ? parsed.brand_compliance : 1.0,
    };

    const feedback = typeof parsed.feedback === 'string'
      ? parsed.feedback
      : 'No feedback provided';

    // Collect per-dimension reasons for post-hoc diagnosis
    const reasons: Record<string, string> = {};
    for (const key of Object.keys(parsed)) {
      if (key.endsWith('_reason') && typeof parsed[key] === 'string') {
        reasons[key.replace(/_reason$/, '')] = parsed[key];
      }
    }

    return { detail, feedback, reasons, rawResponse: text };
  } catch (err) {
    console.error('[qa-scorer] Failed to parse QA response:', err, '\nRaw:', text);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scoring function
// ─────────────────────────────────────────────────────────────────────────────

export async function scoreImage(request: ScoreImageRequest): Promise<ScoreImageResult> {
  const generationMode = request.actualMode || request.strategy.generation_mode;

  const prompt = buildQAPrompt(
    request.strategy,
    request.swatchName,
    generationMode,
    request.swatchHex,
    request.brand,
    request.shotType
  );

  // Send 3 images: generated + swatch + hero
  const result = await analyzeImages({
    images: [
      { base64: request.generatedBase64, mimeType: request.generatedMimeType || 'image/png' },
      { base64: request.swatchBase64, mimeType: request.swatchMimeType || 'image/png' },
      { base64: request.heroBase64, mimeType: request.heroMimeType || 'image/png' },
    ],
    promptText: prompt,
    temperature: 0.1,
  });

  if (!result.success || !result.textResponse) {
    throw new Error(`QA analysis failed: ${result.error || 'No response'}`);
  }

  const parsed = parseQAResponse(result.textResponse);

  if (!parsed) {
    throw new Error(`QA analysis returned unparseable response: ${result.textResponse?.substring(0, 200)}`);
  }

  const score = computeWeightedScore(parsed.detail, request.projectSettings);
  const action = determineAction(score, parsed.detail, request.strategy, request.attempt, request.projectSettings);

  console.log(
    `[qa-scorer] Score: ${(score * 100).toFixed(0)}% | ` +
    `Fidelity: ${(parsed.detail.product_fidelity * 100).toFixed(0)}% | ` +
    `Color: ${(parsed.detail.color_accuracy * 100).toFixed(0)}% | ` +
    `Contamination: ${(parsed.detail.hero_contamination * 100).toFixed(0)}% | ` +
    `Action: ${action.action}${action.escalate ? ' (ESCALATE)' : ''} | ` +
    `${action.reason}`
  );

  return {
    score,
    detail: parsed.detail,
    feedback: parsed.feedback,
    action,
    durationMs: result.durationMs,
    reasons: parsed.reasons,
    rawResponse: parsed.rawResponse,
  };
}

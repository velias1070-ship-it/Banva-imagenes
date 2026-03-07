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

export interface ScoreImageRequest {
  generatedBase64: string;
  generatedMimeType?: string;
  swatchBase64: string;
  swatchMimeType?: string;
  heroBase64: string;       // ALWAYS present — even for from_scratch, hero is the composition reference
  heroMimeType?: string;
  category: string;
  swatchName: string;
  strategy: CategoryStrategy;
  attempt: number;
}

export interface ScoreImageResult {
  score: number;
  detail: QADetail;
  feedback: string;
  action: QAAction;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build QA prompt for Gemini analysis
// ─────────────────────────────────────────────────────────────────────────────

function buildQAPrompt(
  strategy: CategoryStrategy,
  swatchName: string,
  generationMode: string
): string {
  const focusAreas = strategy.qa_focus_areas?.length
    ? `\nCATEGORY-SPECIFIC FOCUS AREAS:\n${strategy.qa_focus_areas.map((a) => `* ${a}`).join('\n')}`
    : '';

  return `You are a quality assurance expert for e-commerce product photography. Your job is to evaluate a generated image against its reference materials.

You are given 3 images:
- IMAGE 1: The GENERATED product image (to be evaluated)
- IMAGE 2: The SWATCH REFERENCE — this shows the CORRECT fabric color, pattern, and texture for the product called "${swatchName}"
- IMAGE 3: The HERO/COMPOSITION REFERENCE — this shows the DESIRED composition, camera angle, and scene layout

The generation mode was: ${generationMode}
Product category: ${strategy.label}

EVALUATE Image 1 across these 8 dimensions. Score each from 0.0 to 1.0:

1. **product_fidelity** (0-1): Does Image 1's textile product EXACTLY match Image 2's fabric?
   - Same color/hue? Same pattern/design? Same texture/stitch?
   - If the product's pattern was INVENTED (not from swatch) → score 0.0-0.2
   - If the color is wrong → score 0.2-0.4
   - If minor deviations → 0.6-0.8
   - If exact match → 0.9-1.0

2. **color_accuracy** (0-1): How accurately does Image 1 reproduce Image 2's colors?
   - Exact hue + saturation + brightness match → 1.0
   - Slight shift → 0.7-0.9
   - Wrong color → 0.0-0.3

3. **composition_match** (0-1): Does Image 1 match Image 3's composition?
   - Same camera angle? Same product placement? Same number of items?
   - For ${generationMode === 'from_scratch' ? 'from_scratch mode, evaluate if the composition is commercially appropriate (not identical to Image 3)' : 'edit/reference mode, it should closely match Image 3'}

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
   - No watermarks, no text overlays, no logos → 1.0
   - Contains unwanted text/watermarks → lower

8. **hero_contamination** (0-1): Did Image 3's ORIGINAL fabric pattern bleed into Image 1?
   - 0.0 = CLEAN — Image 1's fabric comes entirely from Image 2 (swatch)
   - 0.5 = PARTIAL — some elements from Image 3's fabric visible
   - 1.0 = FULL — Image 1 looks like Image 3 with no fabric change
   - This measures whether the generation FAILED to replace the original textile
${focusAreas}

RESPOND WITH ONLY a valid JSON object (no markdown, no backticks, no explanation before or after):
{
  "product_fidelity": <number>,
  "color_accuracy": <number>,
  "composition_match": <number>,
  "visual_quality": <number>,
  "resolution": <number>,
  "aspect_ratio": <number>,
  "ml_compliance": <number>,
  "hero_contamination": <number>,
  "feedback": "<one sentence explaining the most critical issue, or 'Excellent quality' if all good>"
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse Gemini's QA response into structured data
// ─────────────────────────────────────────────────────────────────────────────

function parseQAResponse(text: string): { detail: QADetail; feedback: string } | null {
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
    };

    const feedback = typeof parsed.feedback === 'string'
      ? parsed.feedback
      : 'No feedback provided';

    return { detail, feedback };
  } catch (err) {
    console.error('[qa-scorer] Failed to parse QA response:', err, '\nRaw:', text);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scoring function
// ─────────────────────────────────────────────────────────────────────────────

export async function scoreImage(request: ScoreImageRequest): Promise<ScoreImageResult> {
  const generationMode = request.strategy.generation_mode;

  const prompt = buildQAPrompt(
    request.strategy,
    request.swatchName,
    generationMode
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

  const score = computeWeightedScore(parsed.detail);
  const action = determineAction(score, parsed.detail, request.strategy, request.attempt);

  console.log(
    `[qa-scorer] Score: ${(score * 100).toFixed(0)}% | ` +
    `Fidelity: ${(parsed.detail.product_fidelity * 100).toFixed(0)}% | ` +
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
  };
}

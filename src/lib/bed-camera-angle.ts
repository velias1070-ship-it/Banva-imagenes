// Detects how horizontal stripes WOULD APPEAR on a bed photo, used to decide
// whether the swatch needs pre-rotation before sending to Gemini.
//
// Why this framing instead of "what camera angle":
// The angle-based classifier (foot vs side) is unreliable because two bed
// photos with similar 3/4 perspectives can require different swatch rotations.
// Asking the model the *direct* downstream question — "would horizontal stripes
// appear left-right or top-bottom in this view?" — gives consistent answers
// (verified empirically: 5/5 across both Flash and Pro on the two test heros).
//
// Mapping to rotation:
//   left_right → no rotation (horizontal-in-camera = correct for this view)
//   top_bottom → rotate 90°  (horizontal-in-camera would be wrong; flip swatch)

import { analyzeImages } from '@/lib/gemini/client';

export type StripeVisualAxis = 'left_right' | 'top_bottom';
// Backwards-compat alias for any callers still importing the old name.
export type BedCameraAngle = StripeVisualAxis;

export async function detectStripeVisualAxis(
  heroBase64: string,
  heroMimeType: string = 'image/png'
): Promise<StripeVisualAxis | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: heroBase64, mimeType: heroMimeType }],
      promptText: `Look at this bed photo. The bedspread/quilt covers a bed.

Imagine you're going to put a horizontally-striped fabric on this bed (stripes parallel to the foot edge of the bed and parallel to the headboard, going ACROSS the WIDTH of the bed).

Question: In the resulting image, would those stripes APPEAR to run LEFT-TO-RIGHT in the camera frame, or TOP-TO-BOTTOM in the camera frame?

Think step by step:
1. Where is the headboard? Where is the foot of the bed?
2. The bed's WIDTH axis runs from one side rail to the other (parallel to head/foot edges).
3. Which direction does the WIDTH axis appear to go in this camera view?
   - WIDTH axis appears mostly LEFT-RIGHT in camera → stripes appear LEFT-TO-RIGHT
   - WIDTH axis appears mostly TOP-BOTTOM in camera (or steeply diagonal) → stripes appear TOP-TO-BOTTOM

Reply ONLY a valid JSON object (no markdown, no backticks):
{"stripes_appear": "left_right" or "top_bottom", "confidence": 0.0-1.0}`,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[stripe-visual-axis] Analysis failed:', result.error);
      return null;
    }

    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    const v = parsed?.stripes_appear;
    if (v !== 'left_right' && v !== 'top_bottom') return null;
    return v;
  } catch (err) {
    console.error('[stripe-visual-axis] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Backwards-compat: keep the old function name working but route it through
// the new classifier.
export const detectBedCameraAngle = detectStripeVisualAxis;

// Returns true if the cached swatch description indicates a directional pattern
// (stripes/chevron/diagonal). Used to gate the rotation logic — non-directional
// patterns like florals/geometrics are rotation-invariant and don't need this fix.
export function hasDirectionalPattern(description: string | null | undefined): boolean {
  if (!description) return false;
  const lower = description.toLowerCase();
  return /\bstrip(e|es|ed)\b/.test(lower)
    || /\bchevron\b/.test(lower)
    || /\bdiagonal(ly)?\b/.test(lower)
    || /\bhorizontal(ly)?\b/.test(lower)
    || /\bvertical(ly)?\b/.test(lower);
}

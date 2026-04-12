// Detects the camera angle of a hero shot containing a bed.
// Used to decide whether the swatch needs pre-rotation before sending to Gemini:
// stripe/chevron patterns get rotated 90° on side-angle heros because Gemini
// interprets pattern direction relative to the camera, not the bed's anatomy.

import { analyzeImages } from '@/lib/gemini/client';

export type BedCameraAngle = 'foot' | 'side' | 'top' | 'other';

export async function detectBedCameraAngle(
  heroBase64: string,
  heroMimeType: string = 'image/png'
): Promise<BedCameraAngle | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: heroBase64, mimeType: heroMimeType }],
      promptText: `Analyze the camera angle of this bed photo for a textile product listing.

The image shows a bed with a bedspread/quilt. I need to know HOW the camera is positioned relative to the bed.

Possible angles:
- "foot": Camera is at the FOOT of the bed looking toward the headboard. The headboard is at the back of the frame, the foot of the bed is closest to the camera. The bed extends INTO the frame (depth = bed length).
- "side": Camera is at a SIDE angle (typically 30-60 degrees off-axis). One side rail of the bed is closer to the camera, the other side is farther. The bed extends ACROSS the frame from one side to the other.
- "top": Camera is directly above the bed (overhead/flat-lay).
- "other": No bed visible, or some other angle (extreme close-up of fabric, etc).

KEY DECISION RULE — focus on which axis of the bed runs from one side of the frame to the other:
- If the LONG axis of the bed runs into the depth of the frame (you see foot → headboard going away from you) → "foot"
- If the LONG axis of the bed runs across the frame (left-to-right) → "side"
- If looking straight down → "top"

Reply with ONLY a valid JSON object (no markdown, no backticks):
{
  "angle": "<foot|side|top|other>",
  "confidence": <0.0 to 1.0>,
  "reason": "<one short sentence explaining what you see>"
}`,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[bed-camera-angle] Analysis failed:', result.error);
      return null;
    }

    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    const valid: BedCameraAngle[] = ['foot', 'side', 'top', 'other'];
    if (!parsed.angle || !valid.includes(parsed.angle)) return null;
    return parsed.angle as BedCameraAngle;
  } catch (err) {
    console.error('[bed-camera-angle] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}

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

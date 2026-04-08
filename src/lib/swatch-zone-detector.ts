import { analyzeWithProModel } from '@/lib/gemini/client';

export interface SwatchZones {
  pillowcase: { top: number; left: number; width: number; height: number } | null;
  sheet: { top: number; left: number; width: number; height: number } | null;
  fullWidth: number;
  fullHeight: number;
}

/**
 * Uses Gemini 2.5 Pro to detect the zones of each piece in a sabanas swatch.
 * Returns pixel coordinates for cropping pillowcase and sheet zones separately.
 */
export async function detectSwatchZones(
  swatchBase64: string,
  swatchMimeType: string,
  imageWidth: number,
  imageHeight: number,
): Promise<SwatchZones | null> {
  const prompt = `This image shows a bed sheet set (juego de sabanas) with MULTIPLE pieces visible:
- PILLOWCASES (fundas de almohada) — usually at the top of the image
- FITTED SHEET or FLAT SHEET (sabana) — usually the larger surface area

The image is ${imageWidth}x${imageHeight} pixels.

Identify the bounding box of EACH piece. Return JSON with pixel coordinates:
{
  "pillowcase": { "top": <y>, "left": <x>, "width": <w>, "height": <h> },
  "sheet": { "top": <y>, "left": <x>, "width": <w>, "height": <h> }
}

Rules:
- The pillowcase zone should capture ONE pillowcase fully (the most visible one)
- The sheet zone should capture the largest visible sheet surface (NOT the pillowcases)
- Coordinates must be in pixels within 0-${imageWidth} (x) and 0-${imageHeight} (y)
- If a piece is not clearly visible, set it to null

Respond ONLY with valid JSON (no markdown, no backticks).`;

  try {
    const result = await analyzeWithProModel({
      images: [{ base64: swatchBase64, mimeType: swatchMimeType }],
      promptText: prompt,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[swatch-zone-detector] Analysis failed:', result.error);
      return null;
    }

    const text = result.textResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    console.log(`[swatch-zone-detector] Zones detected: pillowcase=${JSON.stringify(parsed.pillowcase)}, sheet=${JSON.stringify(parsed.sheet)}`);

    return {
      pillowcase: parsed.pillowcase || null,
      sheet: parsed.sheet || null,
      fullWidth: imageWidth,
      fullHeight: imageHeight,
    };
  } catch (err) {
    console.error('[swatch-zone-detector] Error:', err);
    return null;
  }
}

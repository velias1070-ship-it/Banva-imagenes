import { generateImage } from '@/lib/gemini/client';

/**
 * Uses Gemini Flash to generate a flat, straight-on view of the fabric pattern
 * from a product photo. The result shows ONLY the textile pattern without
 * perspective distortion, folds, or background elements.
 *
 * Returns the flattened image as a Buffer, or null if generation fails.
 */
export async function flattenSwatchWithAI(
  swatchBase64: string,
  swatchMimeType: string,
  patternDescription?: string
): Promise<Buffer | null> {
  const prompt = `Look at this product photo carefully. Extract ONLY the fabric/textile pattern visible on the product.

Generate a NEW image showing this EXACT same pattern as a flat fabric swatch:
- Photograph the pattern as if the fabric is laying FLAT on a table, shot from directly above
- NO perspective distortion, NO folds, NO wrinkles, NO bed, NO furniture
- Fill the ENTIRE frame with the fabric pattern — edge to edge
- The pattern must be IDENTICAL to what's on the product: same flowers, same colors, same scale, same style
- Show the TEXTILE TEXTURE too — if the fabric is quilted, show the quilting stitching pattern
- Resolution: 800x800px, RGB, PNG
${patternDescription ? `\nThe pattern is described as: "${patternDescription}"` : ''}

CRITICAL: Reproduce the pattern EXACTLY as it appears on the product. Do NOT simplify, abstract, or reinterpret it.`;

  try {
    // TODO Sprint 2: bypassa generateImageSmart, candidato refactor.
    // Sin telemetría provider_used/model_id/cost_usd_actual hoy.
    const result = await generateImage({
      swatchImageBase64: swatchBase64,
      swatchMimeType: swatchMimeType,
      promptText: prompt,
      temperature: 0.2,
    });

    if (result.success && result.imageBase64) {
      return Buffer.from(result.imageBase64, 'base64');
    }
    console.error('[swatch-flattener] Generation failed:', result.error);
    return null;
  } catch (err) {
    console.error('[swatch-flattener] Error:', err);
    return null;
  }
}

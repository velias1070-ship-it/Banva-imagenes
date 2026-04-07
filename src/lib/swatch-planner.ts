import { analyzeImages } from '@/lib/gemini/client';

/**
 * Pre-generation analysis: describes the swatch pattern in detail so the
 * generator has both visual AND textual reference for accurate reproduction.
 * Uses Gemini Flash vision-only (text response, no image generation).
 *
 * Returns a detailed description or null if analysis fails.
 * Cache-friendly: result can be stored in swatch.color_description.
 */
export async function analyzeSwatchPattern(
  swatchBase64: string,
  swatchMimeType: string,
  swatchName: string,
): Promise<string | null> {
  const prompt = `Analyze this textile product image in extreme detail. Describe EXACTLY what you see on the fabric:

1. PATTERN TYPE: Is it floral, geometric, solid color, striped, abstract, animal print, etc.?
2. SPECIFIC DESIGN ELEMENTS: Describe each element precisely — flower shapes, leaf styles, line thickness, motif sizes, spacing between elements
3. COLOR PALETTE: List every color visible on the fabric with specifics (e.g., "warm golden yellow", "charcoal gray with blue undertone", "cool white background")
4. PATTERN SCALE: How large are the motifs relative to the fabric? Dense/sparse? Regular/random?
5. TEXTURE: Is the fabric quilted (visible stitching)? What type of quilting — channel, diamond, stipple? Is it smooth, textured, embossed?
6. PATTERN DISTRIBUTION: Is the pattern all-over, only on borders, concentrated in center?
7. ARTISTIC STYLE: Watercolor, photorealistic, line drawing, abstract, botanical illustration?

Be EXTREMELY specific — this description will be used to reproduce the pattern on a different product photo. Any detail you miss will be lost.

Respond in a single paragraph, no bullet points. Start with the most important visual characteristic.`;

  try {
    const result = await analyzeImages({
      images: [{ base64: swatchBase64, mimeType: swatchMimeType }],
      promptText: prompt,
    });

    if (result.success && result.textResponse) {
      const description = result.textResponse.trim();
      console.log(`[swatch-planner] Pattern analysis for "${swatchName}": ${description.substring(0, 120)}...`);
      return description;
    }
    console.error('[swatch-planner] Analysis failed:', result.error);
    return null;
  } catch (err) {
    console.error('[swatch-planner] Error:', err);
    return null;
  }
}

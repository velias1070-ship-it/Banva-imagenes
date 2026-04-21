import { analyzeImages } from '@/lib/gemini/client';

/**
 * Compares hero and swatch textures using Gemini Flash.
 * Returns true if patterns are similar enough for edit mode (color change only).
 * Returns false if patterns differ and reference/from_scratch is needed.
 */
export async function arePatternsSimlar(
  heroBase64: string,
  heroMimeType: string,
  swatchBase64: string,
  swatchMimeType: string,
): Promise<boolean> {
  const prompt = `Compare the QUILTING/TEXTILE PATTERN of these two images (ignore color, ignore background, ignore objects).

Image 1: hero product photo
Image 2: swatch/reference fabric

Are the fabric STITCH PATTERNS the same type? (e.g. both waffle, both diamond, both piqué, both channel, etc.)
Minor scale differences are OK — focus on whether the pattern TYPE matches.

Respond ONLY with JSON: {"same_pattern": true or false}`;

  try {
    const result = await analyzeImages({
      images: [
        { base64: heroBase64, mimeType: heroMimeType },
        { base64: swatchBase64, mimeType: swatchMimeType },
      ],
      promptText: prompt,
      temperature: 0.1,
      modelOverride: 'gemini-2.5-flash', // 2.0-flash está saturado, mata chain
      maxRetries: 1, // fail fast — pattern comparison es enriquecimiento
    });

    if (!result.success || !result.textResponse) return false;

    const text = result.textResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);
    const same = parsed.same_pattern === true;
    console.log(`[pattern-comparator] Patterns ${same ? 'SIMILAR → edit mode' : 'DIFFERENT → reference mode'}`);
    return same;
  } catch (err) {
    console.error('[pattern-comparator] Error (defaulting to reference):', err);
    return false;
  }
}

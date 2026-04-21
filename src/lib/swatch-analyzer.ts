// ─────────────────────────────────────────────────────────────────────────────
// Swatch Color Analyzer — Auto-detect color/pattern from swatch images
// ─────────────────────────────────────────────────────────────────────────────
// Uses Gemini Flash (text-only analysis) to describe the swatch's color.
// Results are cached in the `swatches` table (color_description, dominant_color_hex).
// Called lazily by process-next when a swatch lacks color_description.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeImages } from '@/lib/gemini/client';

export interface SwatchColorAnalysis {
  colorDescription: string;
  dominantHex: string | null;
}

/**
 * Analyze a swatch image to extract its dominant color and pattern description.
 * Uses Gemini Flash for fast, cheap analysis (~2s, ~$0.001).
 *
 * @returns Color analysis or null if analysis fails (non-blocking)
 */
export async function analyzeSwatchColor(
  swatchBase64: string,
  swatchMimeType: string = 'image/png'
): Promise<SwatchColorAnalysis | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: swatchBase64, mimeType: swatchMimeType }],
      promptText: `You are analyzing a fabric/textile swatch image for an e-commerce product photography pipeline.

Your job: Identify the DOMINANT COLOR and any visible PATTERN of the textile/fabric shown.

Be SPECIFIC and PRECISE about the color. Good examples:
- "olive green" (not just "green")
- "deep navy blue" (not just "blue")
- "coral salmon" (not just "pink")
- "charcoal gray" (not just "gray")
- "cream beige" (not just "white")
- "burgundy red" (not just "red")
- "sage green" (not just "green")
- "dusty rose" (not just "pink")
- "warm terracotta" (not just "orange")

IMPORTANT: The image may show a FULL PRODUCT PHOTO (quilt on a bed, towel set, etc.), not just a fabric closeup.
Focus on the TEXTILE PRODUCT's color — ignore backgrounds, furniture, walls, etc.

If the fabric has multiple colors in a pattern, describe the PRIMARY/DOMINANT color first, then the pattern.
If the fabric is essentially solid/uniform color with texture (quilting, weave), focus on the color.

Respond with ONLY a valid JSON object (no markdown, no backticks, no extra text):
{
  "color": "<2-5 word specific color description>",
  "hex": "<best guess hex color code, e.g. #6B8E23>",
  "has_pattern": <true if visible pattern beyond texture/quilting, false if solid>
}`,
      temperature: 0.1,
      modelOverride: 'gemini-2.5-flash',
      maxRetries: 1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[swatch-analyzer] Analysis failed:', result.error);
      return null;
    }

    // Parse JSON response (handle potential markdown wrapping)
    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.color || typeof parsed.color !== 'string') {
      console.error('[swatch-analyzer] Invalid response — missing color field');
      return null;
    }

    return {
      colorDescription: parsed.color,
      dominantHex: parsed.hex || null,
    };
  } catch (err) {
    console.error('[swatch-analyzer] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}

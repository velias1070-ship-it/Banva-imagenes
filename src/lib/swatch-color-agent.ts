import { analyzeImages } from '@/lib/gemini/client';

export type SwatchColor = { r: number; g: number; b: number; hex: string; productType: string; confidence: number };

const PROMPT = `You are a color extraction agent for a textile product photo.

This image shows a BANVA textile product (curtain, quilt, sheet, towel, rug, pillow, cushion, etc.), photographed either as a closeup swatch or in a lifestyle setting with furniture, walls, windows, plants, or people.

Your job: identify the fabric/textile of the product and return its dominant BASE color.

Rules:
- Ignore the background (walls, floor, window, sky, furniture, props, plants, people, pets, headboard, lamp, nightstand).
- Ignore any white frame, studio backdrop, or packaging.
- Return the BASE color of the fabric — the color a buyer would describe first. If the fabric has a colored pattern ON TOP OF a solid base (e.g. white sheets with blue floral accents, or gray sheets with red stripes), return the BASE color (white/gray), not the accent color.
- If the fabric is solid (single color throughout), return that color.
- "Base" means the color covering the most area, which the pattern sits on top of.

Respond with ONLY this JSON, no prose, no markdown fences:
{"product_type":"curtain|quilt|sheet|towel|rug|pillow|cushion|other","fabric_hex":"#RRGGBB","confidence":0.0}`;

function hexToRgb(h: string): { r: number; g: number; b: number } | null {
  const m = h.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
}

export async function extractSwatchBaseColorVLM(
  swatchBuffer: Buffer,
  mimeType: string,
): Promise<SwatchColor | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: swatchBuffer.toString('base64'), mimeType }],
      promptText: PROMPT,
      temperature: 0.1,
      modelOverride: 'gemini-2.5-flash',
      maxRetries: 1,
    });
    if (!result.success || !result.textResponse) return null;
    const cleaned = result.textResponse.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { product_type?: string; fabric_hex?: string; confidence?: number };
    if (!parsed.fabric_hex) return null;
    const rgb = hexToRgb(parsed.fabric_hex);
    if (!rgb) return null;
    return { ...rgb, hex: parsed.fabric_hex.toUpperCase(), productType: parsed.product_type || 'other', confidence: parsed.confidence || 0 };
  } catch {
    return null;
  }
}

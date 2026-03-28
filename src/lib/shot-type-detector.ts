// ─────────────────────────────────────────────────────────────────────────────
// Shot Type Detector — Auto-detect the type of hero shot from visual content
// ─────────────────────────────────────────────────────────────────────────────
// Uses Gemini Flash to analyze the hero image and determine the actual shot
// type, overriding the user's manual classification if incorrect.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeImages } from '@/lib/gemini/client';

export type DetectedShotType = 'main' | 'lifestyle' | 'detail' | 'doblada' | 'flatlay' | 'infografia';

export interface ShotTypeDetection {
  detected_type: DetectedShotType;
  confidence: number;
  description: string;
}

/**
 * Analyze a hero shot image to determine its actual shot type.
 * Uses Gemini Flash for fast, cheap analysis (~2s, ~$0.001).
 *
 * @returns Detection result or null if analysis fails (non-blocking)
 */
export async function detectShotType(
  heroBase64: string,
  heroMimeType: string = 'image/png'
): Promise<ShotTypeDetection | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: heroBase64, mimeType: heroMimeType }],
      promptText: `Analiza esta imagen de producto para e-commerce y clasifica el TIPO DE TOMA.

Tipos posibles:
- "main": Producto en fondo blanco puro, sin escenario. Foto de catalogo.
- "lifestyle": Producto en un ESCENARIO real (dormitorio, baño, mesa). Se ve mobiliario, decoracion, ambiente.
- "detail": Close-up / acercamiento de TEXTURA de la tela. Se ve la fibra, el tejido, pliegues de cerca. NO hay escenario ni producto completo visible.
- "doblada": Producto DOBLADO, APILADO o EMPAQUETADO. Puede tener etiqueta, cinta, moño. Se ve el producto completo pero presentado como packaging.
- "flatlay": Vista desde arriba del producto extendido sobre una superficie plana.
- "infografia": Imagen con TEXTO superpuesto, iconos, features, sellos de certificacion. Puede tener el producto de fondo con informacion grafica encima.

REGLAS DE DECISION:
- Si SOLO se ve textura de tela de cerca sin producto completo → "detail"
- Si tiene texto/iconos/features superpuestos → "infografia"
- Si el producto esta doblado/apilado con etiqueta → "doblada"
- Si hay fondo blanco puro sin escenario → "main"
- Si hay escenario real (muebles, ambiente) → "lifestyle"

Responde con SOLO un JSON valido (sin markdown, sin backticks):
{
  "type": "<main|lifestyle|detail|doblada|flatlay|infografia>",
  "confidence": <0.0 a 1.0>,
  "description": "<descripcion breve de lo que se ve en la imagen>"
}`,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.error('[shot-type-detector] Analysis failed:', result.error);
      return null;
    }

    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.type || typeof parsed.type !== 'string') {
      console.error('[shot-type-detector] Invalid response — missing type field');
      return null;
    }

    const validTypes: DetectedShotType[] = ['main', 'lifestyle', 'detail', 'doblada', 'flatlay', 'infografia'];
    const detectedType = validTypes.includes(parsed.type) ? parsed.type as DetectedShotType : 'lifestyle';

    return {
      detected_type: detectedType,
      confidence: parsed.confidence || 0.5,
      description: parsed.description || '',
    };
  } catch (err) {
    console.error('[shot-type-detector] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}

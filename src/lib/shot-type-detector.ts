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
const SHOT_TYPE_PROMPT = `Analiza esta imagen de producto textil y clasifica el TIPO DE TOMA.

Pregunta clave: ¿la imagen muestra un PRODUCTO EN UN ESCENARIO REAL (cama hecha, dormitorio, muebles) O es un CLOSE-UP del producto SIN escenario?

Tipos:
- "main": Producto aislado sobre fondo blanco puro de catalogo. Sin escenario, sin texto promocional.
- "lifestyle": Producto usado en un ESCENARIO REAL — cama hecha, dormitorio, muebles visibles. PUEDE tener texto promocional/logos superpuestos (eso NO cambia la clasificacion). La clave: hay una escena 3D con cama armada y muebles alrededor.
- "detail": Close-up del producto plegado, drapeado o mostrando su textura. NO hay cama hecha ni muebles alrededor. PUEDE tener texto promocional, badges de certificacion (OEKO-TEX), o headlines ("ULTRA-SUAVE") superpuestos — eso NO cambia la clasificacion. Solo importa que sea un close-up del producto SIN escenario de dormitorio.
- "infografia": Layout COMPARATIVO producto vs competidor. Tipicamente tiene un split vertical izquierda/derecha, checkmarks vs X, iconos de caracteristicas enfrentadas. Si la imagen muestra DOS productos comparados lado a lado, es infografia.
- "doblada": Producto doblado/empaquetado como packaging comercial con etiqueta.
- "flatlay": Vista cenital del producto extendido plano sobre superficie.

REGLAS DE DECISION:
1. ¿Hay un layout comparativo lado-a-lado (producto propio vs competidor, con checkmarks o iconos comparativos)? → "infografia"
2. ¿Se ve una CAMA HECHA completa con muebles (mesa de noche, cabecera, lamparas, dormitorio)? → "lifestyle" (aunque tenga texto overlay)
3. ¿Se ve SOLO el producto (plegado, drapeado, close-up) SIN escenario de dormitorio? → "detail" (aunque tenga texto, badges, headlines)
4. ¿Fondo blanco puro de catalogo sin escenario ni texto? → "main"
5. ¿Producto doblado/empaquetado como package? → "doblada"
6. ¿Vista cenital plana? → "flatlay"

IMPORTANTE: el texto overlay, badges OEKO-TEX, y headlines promocionales NO determinan el tipo por si solos. Lo que importa es: ¿hay CAMA+ESCENARIO (lifestyle), CLOSE-UP SOLO (detail), o COMPARACION (infografia)?

Ejemplos:
- Modelo en cama + wicker headboard + "BANVA HOGAR" text → "lifestyle"
- Cama hecha en dormitorio con titulo "ELEGANCIA" → "lifestyle"
- Close-up de quilt plegado + OEKO-TEX badge + "ULTRA-SUAVE" text → "detail"
- Esquina del cubrecama drapeado sin muebles + texto → "detail"
- Split izq/der: producto propio con checkmarks vs competidor con X → "infografia"

Responde SOLO un JSON valido (sin markdown, sin backticks):
{
  "type": "<main|lifestyle|detail|doblada|flatlay|infografia>",
  "confidence": <0.0 a 1.0>,
  "description": "<descripcion breve>"
}`;

async function detectOnce(heroBase64: string, heroMimeType: string): Promise<ShotTypeDetection | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: heroBase64, mimeType: heroMimeType }],
      promptText: SHOT_TYPE_PROMPT,
      temperature: 0.1,
      modelOverride: 'gemini-2.5-flash',
      maxRetries: 1,
    });
    if (!result.success || !result.textResponse) return null;
    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(jsonStr);
    if (!parsed.type || typeof parsed.type !== 'string') return null;
    const validTypes: DetectedShotType[] = ['main', 'lifestyle', 'detail', 'doblada', 'flatlay', 'infografia'];
    if (!validTypes.includes(parsed.type)) return null;
    return {
      detected_type: parsed.type as DetectedShotType,
      confidence: parsed.confidence || 0.5,
      description: parsed.description || '',
    };
  } catch {
    return null;
  }
}

/**
 * 3-call majority vote with gemini-2.5-flash.
 * The old single-call 2.0-flash approach misclassified infografia shots
 * (promotional close-ups with text overlays + badges) as "lifestyle" even
 * when the model's own description acknowledged the text and badge. Same
 * failure mode as the stripe orientation classifier — 2.0-flash lacks
 * reliable perception for these cases.
 */
export async function detectShotType(
  heroBase64: string,
  heroMimeType: string = 'image/png'
): Promise<ShotTypeDetection | null> {
  const runs = await Promise.all([
    detectOnce(heroBase64, heroMimeType),
    detectOnce(heroBase64, heroMimeType),
    detectOnce(heroBase64, heroMimeType),
  ]);
  const valid = runs.filter((r): r is ShotTypeDetection => r !== null);
  if (valid.length === 0) return null;

  // Majority vote on the detected type.
  const counts: Record<string, number> = {};
  for (const r of valid) counts[r.detected_type] = (counts[r.detected_type] || 0) + 1;
  let winningType = valid[0].detected_type;
  let winningCount = 0;
  for (const [t, c] of Object.entries(counts)) {
    if (c > winningCount) {
      winningType = t as DetectedShotType;
      winningCount = c;
    }
  }

  // Average confidence + pick description from a run that matched.
  const matched = valid.filter(r => r.detected_type === winningType);
  const avgConfidence = matched.reduce((s, r) => s + r.confidence, 0) / matched.length;
  return {
    detected_type: winningType,
    confidence: avgConfidence,
    description: matched[0].description,
  };
}

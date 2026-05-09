/**
 * Simula el comportamiento del Job A con el fix de routing aplicado:
 * en lugar de Pro, usa Flash @ temp 0.2 (config del retry) con el prompt
 * de retry (feedback poisoning incluido). Aplica overlay con el codigo
 * actual (con fixes del 1/5) y muestra resultado.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { compositeHeroOverlays } from '../src/lib/image-processing';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const HERO_PATH = '/tmp/hero_smudge.png';
const SWATCH_PATH = '/tmp/hero_review/turquesa_swatch.webp';
const OUT_DIR = '/tmp/hero_review/routing_fix';
mkdirSync(OUT_DIR, { recursive: true });

// Bboxes reales del hero_shot e08c7c79 (de DB hero_shots.text_bboxes)
const REAL_BBOXES = [
  { x: 100, y: 36, width: 60, height: 56 },
  { x: 24, y: 104, width: 212, height: 28 },
  { x: 51, y: 135, width: 157, height: 26 },
  { x: 784, y: 107, width: 414, height: 119 },
  { x: 937, y: 330, width: 41, height: 43 },
  { x: 998, y: 345, width: 189, height: 65 },
  { x: 937, y: 524, width: 41, height: 43 },
  { x: 998, y: 539, width: 129, height: 65 },
  { x: 937, y: 707, width: 41, height: 43 },
  { x: 998, y: 716, width: 167, height: 100 },
  { x: 937, y: 894, width: 41, height: 43 },
  { x: 998, y: 903, width: 188, height: 100 },
  { x: 937, y: 1078, width: 41, height: 43 },
  { x: 998, y: 1087, width: 169, height: 100 },
  { x: 182, y: 1121, width: 191, height: 65 },
];

const PROMPT_RETRY = `Toma Imagen 1 y cámbiale SOLO la tela del producto al color/patrón/textura de Imagen 2. IMPORTANT — Image 2 may show DIFFERENT patterns for different pieces:
* The PILLOWCASES in Image 2 have one pattern (could be floral, striped, etc.)
* The FITTED SHEET (sabana bajera) in Image 2 may have a DIFFERENT pattern (often stripes or solid color)

Apply each pattern to the correct piece in Image 1:
* Pillowcases in Image 1 -> use the PILLOWCASE pattern from Image 2
* The flat surface underneath the pillows (fitted sheet) -> use the FITTED SHEET pattern from Image 2
* If a top sheet is visible in Image 1 -> use its corresponding pattern from Image 2

If Image 2 shows only ONE pattern for everything -> apply that same pattern to all textiles.
If you cannot clearly distinguish the fitted sheet pattern in Image 2 -> use the dominant background color/pattern visible beneath the pillows in Image 2.

IMPORTANT: Sheets (sabanas) are FLAT, thin fabric — they must lay SMOOTH and FLAT on the bed, just like in Image 1. DO NOT add volume, puffiness, or quilting. Sheets are NOT duvets/comforters.

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing
INTENTO ANTERIOR FALLÓ: "[Verifier 2.5 Pro] The generated image incorrectly adds a light-colored distressed pattern to the fabric, which should be a solid teal color."

Imagen 1 es la composición exacta: mantén personas, rostros, expresiones, manos, pelo, fondo, muebles, lámpara, objetos de mesa de noche, almohadas decorativas, iluminación, encuadre y foco idénticos. MISMA cantidad de almohadas, misma posición, mismo tamaño. Solo la tela del producto cambia. Si hay texto en inglés, traducir al español. Sin marcas de agua.

Imagen fotorrealista de 1200x1200.`;

interface GeminiPart {
  inlineData?: { data: string; mimeType: string };
  text?: string;
}

async function callGeminiFlash(): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const endpoint = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';
  const heroBase64 = readFileSync(HERO_PATH).toString('base64');
  const swatchBase64 = readFileSync(SWATCH_PATH).toString('base64');
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: heroBase64 } },
      { inline_data: { mime_type: 'image/webp', data: swatchBase64 } },
      { text: PROMPT_RETRY },
    ] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.2 },
  };
  const url = `${endpoint}/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) throw new Error('No image returned');
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

async function main() {
  const heroBuf = await sharp(readFileSync(HERO_PATH)).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();

  for (let i = 1; i <= 3; i++) {
    const rawOut = `${OUT_DIR}/sample_${i}_raw_flash02.png`;
    const finalOut = `${OUT_DIR}/sample_${i}_final.png`;

    if (existsSync(finalOut)) { console.log(`skip ${finalOut}`); continue; }

    console.log(`\n[${i}] generating Flash @ temp 0.2 with retry prompt...`);
    const rawBuf = await callGeminiFlash();
    writeFileSync(rawOut, rawBuf);
    console.log(`  raw: ${rawOut} (${(rawBuf.length / 1024).toFixed(0)}KB)`);

    // Resize and resize bboxes proportionally to 1080
    const rawMeta = await sharp(rawBuf).metadata();
    const rawBuf1080 = await sharp(rawBuf).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();
    const scaleX = 1080 / (rawMeta.width || 1080);
    const scaleY = 1080 / (rawMeta.height || 1080);
    // Hero bboxes scaled (hero is 1242x1242 → 1080x1080)
    const heroMeta = await sharp(readFileSync(HERO_PATH)).metadata();
    const heroScaleX = 1080 / (heroMeta.width || 1242);
    const heroScaleY = 1080 / (heroMeta.height || 1242);
    const scaledBboxes = REAL_BBOXES.map((bb) => ({
      x: Math.round(bb.x * heroScaleX),
      y: Math.round(bb.y * heroScaleY),
      width: Math.round(bb.width * heroScaleX),
      height: Math.round(bb.height * heroScaleY),
    }));

    const composited = await compositeHeroOverlays(heroBuf, rawBuf1080, scaledBboxes);
    writeFileSync(finalOut, composited);
    console.log(`  final (with overlay): ${finalOut}`);
    void scaleX; void scaleY;

    await new Promise((r) => setTimeout(r, 6000));
  }

  console.log('\nDone. Open:');
  console.log(`  open ${OUT_DIR}/sample_1_final.png ${OUT_DIR}/sample_2_final.png ${OUT_DIR}/sample_3_final.png`);
}

main().catch((err) => { console.error(err); process.exit(1); });

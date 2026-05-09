/**
 * Test ad-hoc: regenerar el job 5e370407 (Roy / sabana hero ChatGPT) con
 * temperatura 0.1 fija para validar la hipotesis de que las "smudges
 * blancas" en la salida Pro venian de temperature=0.2 + luminance del hero.
 *
 * No es parte del pipeline; correr con:
 *   npx tsx scripts/test-roy-temp01.ts
 *
 * Salida: /tmp/hero_review/roy_test_temp01_<modelo>.png
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const HERO_PATH = '/tmp/hero_smudge.png';
const SWATCH_PATH = '/tmp/hero_review/roy_swatch.jpg';
const OUT_DIR = '/tmp/hero_review';

// Fix candidato #4: linea explicita sobre el panel lateral del hero.
// Solo se agrega aqui en el test — si los samples salen bien, se aplica al
// prompt builder de prod.
const PANEL_FIX = `

PANEL LATERAL — NO MODIFICAR:
Imagen 1 tiene un panel blanco a la derecha con texto, iconos (lavadora, gota, plancha) y un layout de "Instrucciones de lavado". Ese panel y todos sus elementos quedan EXACTAMENTE IGUAL en el resultado — misma posición, mismo tamaño, mismos iconos, mismo texto, mismo fondo blanco. NO sangres elementos blancos del panel hacia la zona de la sábana. NO agregues highlights, manchas, ni reflejos blancos sobre la tela. La frontera entre el panel blanco y la zona de la cama debe ser nítida, sin transición difusa.`;

const PROMPT_TEXT = `Toma Imagen 1 y cámbiale SOLO la tela del producto al color/patrón/textura de Imagen 2. IMPORTANT — Image 2 may show DIFFERENT patterns for different pieces:
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
* Persons, hands, or clothing No aclares la tela — debe ser igual de oscura que la Imagen 2.

Imagen 1 es la composición exacta: mantén personas, rostros, expresiones, manos, pelo, fondo, muebles, lámpara, objetos de mesa de noche, almohadas decorativas, iluminación, encuadre y foco idénticos. MISMA cantidad de almohadas, misma posición, mismo tamaño. Solo la tela del producto cambia. Si hay texto en inglés, traducir al español. Sin marcas de agua.

Imagen fotorrealista de 1200x1200.${PANEL_FIX}`;

interface GeminiPart {
  inlineData?: { data: string; mimeType: string };
  text?: string;
}

async function callGemini(modelId: string, temperature: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  const endpoint = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const heroBase64 = readFileSync(HERO_PATH).toString('base64');
  const swatchBase64 = readFileSync(SWATCH_PATH).toString('base64');

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'image/png', data: heroBase64 } },
          { inline_data: { mime_type: 'image/jpeg', data: swatchBase64 } },
          { text: PROMPT_TEXT },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature,
    },
  };

  const url = `${endpoint}/${modelId}:generateContent?key=${apiKey}`;
  console.log(`[test] POST ${modelId} temp=${temperature}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${modelId} HTTP ${res.status} (${elapsed}ms): ${errText.slice(0, 800)}`);
  }
  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error(`No image in response (${elapsed}ms): ${JSON.stringify(data).slice(0, 600)}`);
  }
  const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
  console.log(`[test] OK ${modelId} ${(imgBuf.length / 1024).toFixed(1)}KB in ${elapsed}ms`);
  return imgBuf;
}

async function main() {
  // Bug original (smudges blancas atttempt 1) era Flash @ 0.2 — pero re-run
  // single-sample salio limpio. Hipotesis: smudges son INTERMITENTES.
  // Para validar, sampleamos N=5 a cada temperatura en Flash y contamos
  // tasa de smudges. (Pro queda fuera porque devolvio "no image" 2/2
  // y no es el modelo que produjo el bug.)
  // FASE 2: con PANEL_FIX activo, sampleamos a temp 0.2 (la temp original
  // del fail) para verificar que el fix no rompe nada y mantiene panel +
  // sabana renderizados correctamente.
  const SAMPLES = 5;
  const cells: Array<{ model: string; temp: number; out: string }> = [];
  for (let i = 1; i <= SAMPLES; i++) {
    cells.push({
      model: 'gemini-3.1-flash-image-preview',
      temp: 0.2,
      out: `${OUT_DIR}/roy_panelfix_t02_${i}.png`,
    });
  }

  for (const c of cells) {
    if (existsSync(c.out)) {
      console.log(`[test] skip (already exists): ${c.out}`);
      continue;
    }
    try {
      const buf = await callGemini(c.model, c.temp);
      writeFileSync(c.out, buf);
      console.log(`[test] saved ${c.out}`);
    } catch (err) {
      console.error(`[test] cell failed (${c.model} temp=${c.temp}):`, err);
    }
    // Rate limit: Flash es 9 RPM, esperamos 7s entre calls.
    await new Promise((r) => setTimeout(r, 7000));
  }

  console.log('\nDone. Open:');
  console.log(`  open ${cells.map((c) => c.out).join(' ')}`);
}

main().catch((err) => {
  console.error('[test] FAILED:', err);
  process.exit(1);
});

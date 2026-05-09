/**
 * Ablation test para identificar la causa de las smudges en Job A vs Job B.
 *
 * Hero: e08c7c79 (sabana polar / panel "Instrucciones de lavado")
 * Swatch: 09c7a01c (Turquesa solido)
 *
 * 3 variantes:
 *  V1 — prompt EXACTO de Job A (smudge): incluye "INTENTO ANTERIOR FALLO"
 *       que menciona "distressed pattern". SIN "INSTRUCCIONES DE TEXTO".
 *  V2 — prompt EXACTO de Job B (clean): incluye "INSTRUCCIONES DE TEXTO" con
 *       colores por rol. SIN "INTENTO ANTERIOR FALLO".
 *  V3 — prompt de Job A SIN la linea "INTENTO ANTERIOR FALLO". Si las smudges
 *       desaparecen aqui, la causa es feedback poisoning.
 *
 * Todos los samples corren con Flash @ temp 0.1 (la temp del attempt 0).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const HERO_PATH = '/tmp/hero_smudge.png';
const SWATCH_PATH = '/tmp/hero_review/turquesa_swatch.webp';
const OUT_DIR = '/tmp/hero_review/ablation';
mkdirSync(OUT_DIR, { recursive: true });

const PROMPT_BASE = `Toma Imagen 1 y cámbiale SOLO la tela del producto al color/patrón/textura de Imagen 2. IMPORTANT — Image 2 may show DIFFERENT patterns for different pieces:
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
* Persons, hands, or clothing`;

const FOOTER = `

Imagen 1 es la composición exacta: mantén personas, rostros, expresiones, manos, pelo, fondo, muebles, lámpara, objetos de mesa de noche, almohadas decorativas, iluminación, encuadre y foco idénticos. MISMA cantidad de almohadas, misma posición, mismo tamaño. Solo la tela del producto cambia. Si hay texto en inglés, traducir al español. Sin marcas de agua.

Imagen fotorrealista de 1200x1200.`;

const TEXT_INSTRUCTIONS = `

=== INSTRUCCIONES DE TEXTO ===
OBLIGATORIO: Si la imagen contiene CUALQUIER texto visible, DEBES aplicar estas reglas:
COLORES DE TEXTO POR ROL:
  - label → color: #6D7B85
  - title → color: #2C2C2C
  - icon_label → color: #81ADC8
  - feature → color: #81ADC8
REEMPLAZAR los colores de texto del hero original por los indicados arriba.
=== FIN INSTRUCCIONES DE TEXTO ===`;

const FEEDBACK_POISON = `\nINTENTO ANTERIOR FALLÓ: "[Verifier 2.5 Pro] The generated image incorrectly adds a light-colored distressed pattern to the fabric, which should be a solid teal color."`;

// V1 — prompt EXACTO de Job A (smudge): feedback poisoning + sin texto
const PROMPT_V1 = PROMPT_BASE + FEEDBACK_POISON + FOOTER;

// V2 — prompt EXACTO de Job B (clean): instrucciones de texto, sin feedback
const PROMPT_V2 = PROMPT_BASE + FOOTER + TEXT_INSTRUCTIONS;

// V3 — prompt A sin feedback poisoning (control)
const PROMPT_V3 = PROMPT_BASE + FOOTER;

interface GeminiPart {
  inlineData?: { data: string; mimeType: string };
  text?: string;
}

async function callGemini(modelId: string, temperature: number, prompt: string) {
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
          { inline_data: { mime_type: 'image/webp', data: swatchBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature,
    },
  };

  const url = `${endpoint}/${modelId}:generateContent?key=${apiKey}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} (${elapsed}ms): ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error(`No image (${elapsed}ms)`);
  }
  return { buf: Buffer.from(imagePart.inlineData.data, 'base64'), elapsed };
}

async function main() {
  const SAMPLES = 5;
  const variants: Array<{ name: string; prompt: string; temp: number; model: string }> = [
    // V4: Pro con feedback poisoning (replica EXACTAMENTE Job A retry)
    { name: 'V4_pro_poison', prompt: PROMPT_V1, temp: 0.2, model: 'gemini-3-pro-image-preview' },
    // V5: Pro sin feedback poisoning (control: aisla el poison)
    { name: 'V5_pro_clean', prompt: PROMPT_V3, temp: 0.2, model: 'gemini-3-pro-image-preview' },
  ];

  for (const v of variants) {
    console.log(`\n=== ${v.name} (${v.model}, temp ${v.temp}, ${v.prompt.length} chars) ===`);
    for (let i = 1; i <= SAMPLES; i++) {
      const out = `${OUT_DIR}/${v.name}_${i}.png`;
      if (existsSync(out)) {
        console.log(`  skip ${out}`);
        continue;
      }
      try {
        const { buf, elapsed } = await callGemini(v.model, v.temp, v.prompt);
        writeFileSync(out, buf);
        console.log(`  saved ${out} (${(buf.length / 1024).toFixed(0)}KB, ${elapsed}ms)`);
      } catch (err) {
        console.error(`  FAIL ${out}:`, err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, 7000));
    }
  }

  console.log('\nDone. Inspect:');
  for (const v of variants) {
    const files = Array.from({ length: SAMPLES }, (_, i) => `${OUT_DIR}/${v.name}_${i + 1}.png`);
    console.log(`  ${v.name}:  open ${files.join(' ')}`);
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

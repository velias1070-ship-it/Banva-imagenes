/**
 * OpenAI image client (slot "gpt-image-2" del registry; el modelo real sale
 * de OPENAI_IMAGE_MODEL, default gpt-image-2.5-sunburst).
 *
 * Desde el 2026-09-26 es el PRIMER intento de la cadena: prueba a ciegas sobre
 * 8 fotos reales (toallas, frazada, cortina, manteles, cubrecama; mismas fotos
 * y misma instrucción sin la pista de color del hero) — 2.5 en calidad medium
 * dejó el color más cerca de la muestra que Gemini Flash en las toallas y la
 * cortina dúo, a ~US$0,04 por foto (Flash 1K ≈ US$0,069). Juicio visual, n=8.
 * Si OpenAI falla, generateImageSmart cae a Gemini Flash en la misma llamada.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst';

export interface GPTImageGenRequest {
  heroImageBase64: string;
  heroMimeType: string;
  swatchImageBase64: string;
  swatchMimeType: string;
  promptText: string;
  category?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  size?: '1024x1024' | '1024x1536' | '1536x1024';
}

interface OpenAIUsage {
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens?: number;
}

/**
 * Precio oficial de gpt-image-2 / 2.5 (platform.openai.com/docs/pricing, 2026-09):
 * texto de entrada US$5/M, imagen de entrada US$8/M, imagen de salida US$30/M.
 * Medido 2026-09-26: 2.5 medium ≈ 2.900 tokens de imagen de entrada + ~440 de
 * salida ≈ US$0,04 por foto.
 */
function costoPorTokens(usage?: OpenAIUsage): number | undefined {
  if (!usage) return undefined;
  const det = usage.input_tokens_details ?? {};
  return (det.text_tokens ?? 0) * 5e-6 + (det.image_tokens ?? 0) * 8e-6 + (usage.output_tokens ?? 0) * 30e-6;
}

export interface GPTImageGenResult {
  success: boolean;
  imageBase64?: string;
  imageMimeType?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  costEstimateUsd?: number;
  modelUsed?: string;
}

/**
 * Generate an image using GPT Image 2 via /v1/images/edits with hero + swatch
 * as two reference images. The prompt explicitly references "image 1" and
 * "image 2" — GPT Image 2 handles multi-reference via labeled prompts.
 *
 * Costo: se calcula con los tokens que devuelve la API (ver costoPorTokens).
 */
export async function generateImageGPT2(request: GPTImageGenRequest): Promise<GPTImageGenResult> {
  if (!OPENAI_API_KEY) {
    return { success: false, error: 'OPENAI_API_KEY not configured', durationMs: 0 };
  }
  const start = Date.now();

  try {
    const form = new FormData();
    form.append('model', OPENAI_IMAGE_MODEL);

    const heroBuf = Buffer.from(request.heroImageBase64, 'base64');
    const swatchBuf = Buffer.from(request.swatchImageBase64, 'base64');
    const heroBlob = new Blob([new Uint8Array(heroBuf)], { type: request.heroMimeType });
    const swatchBlob = new Blob([new Uint8Array(swatchBuf)], { type: request.swatchMimeType });
    form.append('image[]', heroBlob, 'hero.png');
    form.append('image[]', swatchBlob, 'swatch.png');

    const cat = request.category || 'textile';
    // La versión anterior decía "ALL textile surfaces" y no protegía textos: en la
    // prueba del 2026-09-26 borró el logo BANVA HOME (mantel olivas), tiñó un párrafo
    // (cortina) y pintó el reverso blanco del cubrecama. Esta versión no lo hizo en 8/8.
    const reinforcedPrompt =
      `Apply the color and fabric pattern of the product in image 2 (the swatch reference) to the product shown in image 1 (the composition hero). ` +
      `Recolor ONLY the product fabric. If image 2 shows parts of the product in a different color (for example a white reverse side, a border or a trim), keep those parts as they look in image 2. ` +
      `Preserve exactly from image 1: composition, camera angle, lighting, background scene, furniture, shadows, reflections, and EVERY logo, brand name, label, text, typography and text color — do not add, remove, move or recolor any of them. ` +
      `Do NOT keep image 1's original fabric color or pattern on the recolored areas. ` +
      `Product category: "${cat}". Output: photorealistic, 1:1 square, same composition as image 1.\n\n` +
      `Additional context from prompt builder:\n${request.promptText}`;
    form.append('prompt', reinforcedPrompt);
    form.append('size', request.size || '1024x1024');
    form.append('quality', request.quality || 'medium');
    form.append('output_format', 'png');

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      // Tope de espera: 2.5 medium tarda ~20 s (gpt-image-2 ~40 s). Si se cuelga,
      // el respaldo a Gemini tiene que alcanzar a correr dentro del maxDuration (300 s).
      signal: AbortSignal.timeout(90_000),
    });
    const durationMs = Date.now() - start;

    if (!res.ok) {
      const rawErr = await res.text().catch(() => '');
      let errObj: Record<string, unknown> = {};
      try { errObj = JSON.parse(rawErr); } catch {}
      const errMsg = (errObj as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
      return {
        success: false,
        error: errMsg,
        errorCode: String(res.status),
        durationMs,
        modelUsed: OPENAI_IMAGE_MODEL,
      };
    }

    const data = (await res.json()) as { data?: Array<{ b64_json?: string }>; usage?: OpenAIUsage };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      return {
        success: false,
        error: 'No image in GPT Image 2 response',
        durationMs,
        modelUsed: OPENAI_IMAGE_MODEL,
      };
    }

    // Costo real por tokens; si la API no manda usage, queda undefined y el
    // adapter usa su estimación fija.
    const costEstimate = costoPorTokens(data.usage);

    return {
      success: true,
      imageBase64: b64,
      imageMimeType: 'image/png',
      durationMs,
      costEstimateUsd: costEstimate,
      modelUsed: OPENAI_IMAGE_MODEL,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: 'NETWORK_ERROR',
      durationMs: Date.now() - start,
      modelUsed: OPENAI_IMAGE_MODEL,
    };
  }
}

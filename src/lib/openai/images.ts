/**
 * OpenAI GPT Image 2 client — selective fallback for jobs where Gemini
 * fails systematically (alfombras with printed illustration patterns,
 * cortinas sheer/velo fabric, pattern_invent rejects).
 *
 * Used as a last-resort or profile-based override in the pipeline, NOT
 * as the primary generator. Gemini Nano Banana 2 remains the default
 * ($0.045/img vs $0.21/img GPT Image 2 standard, $0.10/img batch).
 *
 * See scripts/ab_test_gpt_image_2.ts for the validation script.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

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
 * Cost: ~$0.21/img for 1024×1024 high quality standard, ~$0.10 with batch API.
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
    const reinforcedPrompt =
      `Apply the exact color and fabric pattern from image 2 (the swatch reference) to ALL textile/fabric surfaces of the product shown in image 1 (the composition hero). ` +
      `Preserve exactly from image 1: composition, camera angle, lighting, background scene, furniture, shadows, and reflections. ` +
      `Do NOT keep any of image 1's original fabric color or pattern — replace it completely with image 2's fabric. ` +
      `Product category: "${cat}". Output: photorealistic, 1:1 square, same composition as image 1.\n\n` +
      `Additional context from prompt builder:\n${request.promptText}`;
    form.append('prompt', reinforcedPrompt);
    form.append('size', request.size || '1024x1024');
    form.append('quality', request.quality || 'high');
    form.append('output_format', 'png');

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
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

    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      return {
        success: false,
        error: 'No image in GPT Image 2 response',
        durationMs,
        modelUsed: OPENAI_IMAGE_MODEL,
      };
    }

    // Cost: rough estimate for 1024×1024 high quality. Batch API halves this.
    const costEstimate = (request.quality === 'high' || request.quality === 'auto') ? 0.21 : 0.08;

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

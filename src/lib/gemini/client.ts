const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-image-preview').trim();
export const GEMINI_MODEL_PRO = process.env.GEMINI_MODEL_PRO || 'gemini-3-pro-image-preview';
// gemini-2.0-flash fue retirado por Google (HTTP 404 "no longer available") y dejaba
// el QA scorer atascado en qa_pending. Default ahora gemini-2.5-flash (vivo, mismo modelo
// que todos los callers ya usaban via modelOverride).
const GEMINI_ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-flash';
const GEMINI_VERIFY_MODEL = process.env.GEMINI_VERIFY_MODEL || 'gemini-2.5-pro';
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_RETRIES = 3;

function isRateLimitError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('quota') || lower.includes('rate') || lower.includes('429') || lower.includes('resource_exhausted');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRetryDelay(error: string, attempt: number): number {
  // Try to extract the suggested wait time from the error message
  const match = error.match(/retry in (\d+\.?\d*)/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  // Exponential backoff: 5s, 10s, 20s
  return 5000 * Math.pow(2, attempt);
}

export interface GeminiGenerateRequest {
  heroImageBase64?: string;   // Optional for Tier 2 (generation from scratch)
  heroMimeType?: string;      // Optional for Tier 2 (generation from scratch)
  swatchImageBase64: string;
  swatchMimeType: string;
  promptText: string;
  temperature?: number;
  useProModel?: boolean;      // Escalate to Pro model for difficult cases
}

export interface GeminiSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiResponseMeta {
  finishReason?: string;
  safetyRatings?: GeminiSafetyRating[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  googleRequestId?: string;
  modelUsed?: string;
  // Populated on failure paths too, so we can diagnose why "No image in response"
  textResponse?: string;
  httpStatus?: number;
  rawErrorBody?: string;
}

export interface GeminiGenerateResult {
  success: boolean;
  imageBase64?: string;
  imageMimeType?: string;
  textResponse?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  meta?: GeminiResponseMeta;
}

function extractMeta(
  data: Record<string, unknown> | undefined,
  headers: Headers | undefined,
  modelUsed: string,
): GeminiResponseMeta {
  const candidate = (data?.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  const usage = data?.usageMetadata as Record<string, unknown> | undefined;
  return {
    finishReason: candidate?.finishReason as string | undefined,
    safetyRatings: candidate?.safetyRatings as GeminiSafetyRating[] | undefined,
    usageMetadata: usage
      ? {
          promptTokenCount: usage.promptTokenCount as number | undefined,
          candidatesTokenCount: usage.candidatesTokenCount as number | undefined,
          totalTokenCount: usage.totalTokenCount as number | undefined,
          cachedContentTokenCount: usage.cachedContentTokenCount as number | undefined,
        }
      : undefined,
    modelVersion: data?.modelVersion as string | undefined,
    googleRequestId: headers?.get('x-goog-request-id') || undefined,
    modelUsed,
  };
}

export async function generateImage(request: GeminiGenerateRequest): Promise<GeminiGenerateResult> {
  const model = request.useProModel ? GEMINI_MODEL_PRO : GEMINI_MODEL;
  const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${GEMINI_API_KEY}`;
  console.log(`[gemini] Using model: ${model}${request.useProModel ? ' (PRO escalation)' : ''}`);
  const start = Date.now();

  // Build parts array conditionally:
  // - Tier 1 (edit mode): hero (Image 1) + swatch (Image 2) + prompt
  // - Tier 2 (from scratch): swatch only (Image 1) + prompt
  const parts: Array<Record<string, unknown>> = [];

  if (request.heroImageBase64 && request.heroMimeType) {
    parts.push({
      inline_data: {
        mime_type: request.heroMimeType,
        data: request.heroImageBase64,
      },
    });
  }

  parts.push({
    inline_data: {
      mime_type: request.swatchMimeType,
      data: request.swatchImageBase64,
    },
  });

  parts.push({ text: request.promptText });

  const body = {
    contents: [{
      parts,
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: request.temperature ?? 0.2,
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const rawErrorBody = await response.text().catch(() => '');
        let errorData: Record<string, unknown> = {};
        try { errorData = JSON.parse(rawErrorBody); } catch {}
        const errorMsg = (errorData as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;

        // Retry on rate limit errors
        if (isRateLimitError(errorMsg) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(errorMsg, attempt);
          console.log(`[gemini] Rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        return {
          success: false,
          error: errorMsg,
          errorCode: String(response.status),
          durationMs,
          meta: {
            ...extractMeta(errorData, response.headers, model),
            httpStatus: response.status,
            rawErrorBody: rawErrorBody.slice(0, 2000),
          },
        };
      }

      const data = await response.json();
      const responseParts = data?.candidates?.[0]?.content?.parts || [];
      const meta = extractMeta(data, response.headers, model);

      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;
      let textResponse: string | undefined;

      for (const part of responseParts) {
        if (part.inlineData) {
          imageBase64 = part.inlineData.data;
          imageMimeType = part.inlineData.mimeType;
        } else if (part.text) {
          textResponse = part.text;
        }
      }

      if (!imageBase64) {
        return {
          success: false,
          error: 'No image in Gemini response',
          textResponse,
          durationMs,
          meta: { ...meta, textResponse },
        };
      }

      return {
        success: true,
        imageBase64,
        imageMimeType,
        textResponse,
        durationMs,
        meta: { ...meta, textResponse },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';

      // Retry on network errors
      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(errorMsg, attempt);
        console.log(`[gemini] Error (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorMsg}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      return {
        success: false,
        error: errorMsg,
        errorCode: 'NETWORK_ERROR',
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    success: false,
    error: 'Max retries exceeded',
    errorCode: 'MAX_RETRIES',
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-only analysis (for QA scoring) — uses a fast model, no image generation
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiAnalysisRequest {
  images: Array<{ base64: string; mimeType: string }>;
  promptText: string;
  temperature?: number;
  modelOverride?: string;
  /** Override default MAX_RETRIES (3) for this call. Use for optional
   * enrichment analyses (swatch-planner, etc.) that should fail fast
   * instead of burning the handler's 60s Vercel budget on backoff waits. */
  maxRetries?: number;
}

export interface GeminiAnalysisResult {
  success: boolean;
  textResponse?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  meta?: GeminiResponseMeta;
}

export async function analyzeImages(request: GeminiAnalysisRequest): Promise<GeminiAnalysisResult> {
  const modelName = request.modelOverride || GEMINI_ANALYSIS_MODEL;
  const maxRetries = request.maxRetries ?? MAX_RETRIES;
  const url = `${GEMINI_ENDPOINT}/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  const start = Date.now();

  const parts: Array<Record<string, unknown>> = [];

  for (const img of request.images) {
    parts.push({
      inline_data: {
        mime_type: img.mimeType,
        data: img.base64,
      },
    });
  }

  parts.push({ text: request.promptText });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT'],
      temperature: request.temperature ?? 0.1,
    },
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const rawErrorBody = await response.text().catch(() => '');
        let errorData: Record<string, unknown> = {};
        try { errorData = JSON.parse(rawErrorBody); } catch {}
        const errorMsg = (errorData as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;

        if (isRateLimitError(errorMsg) && attempt < maxRetries) {
          const delay = getRetryDelay(errorMsg, attempt);
          console.log(`[gemini-analysis] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        return {
          success: false,
          error: errorMsg,
          errorCode: String(response.status),
          durationMs,
          meta: {
            ...extractMeta(errorData, response.headers, modelName),
            httpStatus: response.status,
            rawErrorBody: rawErrorBody.slice(0, 2000),
          },
        };
      }

      const data = await response.json();
      const responseParts = data?.candidates?.[0]?.content?.parts || [];
      const meta = extractMeta(data, response.headers, modelName);

      let textResponse: string | undefined;
      for (const part of responseParts) {
        if (part.text) {
          textResponse = (textResponse || '') + part.text;
        }
      }

      if (!textResponse) {
        return {
          success: false,
          error: 'No text in Gemini analysis response',
          durationMs,
          meta,
        };
      }

      return {
        success: true,
        textResponse,
        durationMs,
        meta: { ...meta, textResponse },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';

      if (attempt < maxRetries) {
        const delay = getRetryDelay(errorMsg, attempt);
        console.log(`[gemini-analysis] Error (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      return {
        success: false,
        error: errorMsg,
        errorCode: 'NETWORK_ERROR',
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    success: false,
    error: 'Max retries exceeded',
    errorCode: 'MAX_RETRIES',
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pro model verification — uses Gemini 2.5 Pro for high-quality visual analysis
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeWithProModel(request: GeminiAnalysisRequest): Promise<GeminiAnalysisResult> {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_VERIFY_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const start = Date.now();

  const parts: Array<Record<string, unknown>> = [];
  for (const img of request.images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }
  parts.push({ text: request.promptText });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT'],
      temperature: request.temperature ?? 0.1,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const rawErrorBody = await response.text().catch(() => '');
      let errorData: Record<string, unknown> = {};
      try { errorData = JSON.parse(rawErrorBody); } catch {}
      return {
        success: false,
        error: (errorData as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`,
        durationMs: Date.now() - start,
        meta: {
          ...extractMeta(errorData, response.headers, GEMINI_VERIFY_MODEL),
          httpStatus: response.status,
          rawErrorBody: rawErrorBody.slice(0, 2000),
        },
      };
    }

    const data = await response.json();
    const meta = extractMeta(data, response.headers, GEMINI_VERIFY_MODEL);
    const textResponse = data?.candidates?.[0]?.content?.parts
      ?.filter((p: Record<string, unknown>) => p.text)
      .map((p: Record<string, string>) => p.text)
      .join('\n') || '';

    return {
      success: true,
      textResponse,
      durationMs: Date.now() - start,
      meta: { ...meta, textResponse },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', durationMs: Date.now() - start };
  }
}

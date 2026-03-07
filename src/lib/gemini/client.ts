const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';
const GEMINI_ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.0-flash';
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiGenerateRequest {
  heroImageBase64?: string;   // Optional for Tier 2 (generation from scratch)
  heroMimeType?: string;      // Optional for Tier 2 (generation from scratch)
  swatchImageBase64: string;
  swatchMimeType: string;
  promptText: string;
  temperature?: number;
}

export interface GeminiGenerateResult {
  success: boolean;
  imageBase64?: string;
  imageMimeType?: string;
  textResponse?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

export async function generateImage(request: GeminiGenerateRequest): Promise<GeminiGenerateResult> {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData?.error?.message || `HTTP ${response.status}`,
        errorCode: String(response.status),
        durationMs,
      };
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];

    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    let textResponse: string | undefined;

    for (const part of parts) {
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
      };
    }

    return {
      success: true,
      imageBase64,
      imageMimeType,
      textResponse,
      durationMs,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: 'NETWORK_ERROR',
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-only analysis (for QA scoring) — uses a fast model, no image generation
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiAnalysisRequest {
  images: Array<{ base64: string; mimeType: string }>;
  promptText: string;
  temperature?: number;
}

export interface GeminiAnalysisResult {
  success: boolean;
  textResponse?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

export async function analyzeImages(request: GeminiAnalysisRequest): Promise<GeminiAnalysisResult> {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_ANALYSIS_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData?.error?.message || `HTTP ${response.status}`,
        errorCode: String(response.status),
        durationMs,
      };
    }

    const data = await response.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];

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
      };
    }

    return {
      success: true,
      textResponse,
      durationMs,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: 'NETWORK_ERROR',
      durationMs: Date.now() - start,
    };
  }
}

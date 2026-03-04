const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiGenerateRequest {
  heroImageBase64: string;
  heroMimeType: string;
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

  // Build parts array: hero (Image 1) + swatch (Image 2) + prompt text
  const parts: Array<Record<string, unknown>> = [
    {
      inline_data: {
        mime_type: request.heroMimeType,
        data: request.heroImageBase64,
      },
    },
    {
      inline_data: {
        mime_type: request.swatchMimeType,
        data: request.swatchImageBase64,
      },
    },
    { text: request.promptText },
  ];

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

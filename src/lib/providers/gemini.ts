/**
 * Gemini adapter — wraps gemini/client.ts:generateImage() with the
 * uniform ImageGenerator interface.
 *
 * Two adapters are exported (Flash and Pro) because the underlying client
 * picks model via the useProModel boolean rather than a model id string.
 * We bake that decision into the adapter so the registry can list both
 * with distinct ids.
 */

import { generateImage, GEMINI_MODEL } from '@/lib/gemini/client';
import type { ImageGenerator, UnifiedRequest, UnifiedResult } from './types';

const FLASH_MODEL_ID = GEMINI_MODEL;
const PRO_MODEL_ID = (process.env.GEMINI_MODEL_PRO || 'gemini-3-pro-image-preview').trim();

function buildAdapter(modelId: string, useProModel: boolean, costPerImageUsd: number): ImageGenerator {
  return {
    modelId,
    providerFamily: 'gemini',
    costPerImageUsd,
    async generate(req: UnifiedRequest): Promise<UnifiedResult> {
      const result = await generateImage({
        heroImageBase64: req.heroImageBase64,
        heroMimeType: req.heroMimeType,
        swatchImageBase64: req.swatchImageBase64,
        swatchMimeType: req.swatchMimeType,
        promptText: req.promptText,
        temperature: req.temperature,
        useProModel,
      });
      return {
        success: result.success,
        imageBase64: result.imageBase64,
        imageMimeType: result.imageMimeType,
        textResponse: result.textResponse,
        error: result.error,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
        costUsd: costPerImageUsd,
        modelId,
        providerFamily: 'gemini',
        raw: result.meta,
      };
    },
  };
}

// Flash = Nano Banana 2.1. Cobra por tokens: entrada US$1,50/M, texto y "pensamiento" de
// salida US$7,50/M, imagen de salida US$30/M (1K = 1.120 tokens = US$0,0336). En modo edición
// las dos fotos de entrada suman 2.240 tokens y el modelo SIEMPRE piensa (no se puede apagar),
// por eso el precio no es el de la imagen sola. Medido 2026-10-08 en 5 llamadas reales (3 generaciones
// y 2 pasos de marca): US$0,049-0,057, promedio 0,052; el Flash anterior con las mismas 3
// entradas de generación: US$0,069-0,070. Unos 400-600 tokens de salida por llamada vienen
// sin desglose y se contaron a precio de texto; si fueran de imagen el promedio subiría
// hasta ~0,067. Precios: https://ai.google.dev/gemini-api/docs/pricing
// Esta es la ÚNICA fuente del precio de Flash: el registro de modelos la lee de acá.
const FLASH_COST_PER_IMAGE_USD = 0.052;

/**
 * Flash provider — el Gemini más barato: último de la cadena por defecto y único de `brand`
 * (ver config/routing-rules.json). Hoy corre Nano Banana 2.1; el nombre del slot
 * (`gemini-flash`) queda igual porque lo usan routing-rules.json y `provider_used`.
 */
export const geminiFlashProvider: ImageGenerator = buildAdapter(FLASH_MODEL_ID, false, FLASH_COST_PER_IMAGE_USD);

/** Pro provider — segundo de la cadena por defecto (después de ChatGPT); en frazadas va dos veces. */
export const geminiProProvider: ImageGenerator = buildAdapter(PRO_MODEL_ID, true, 0.134);

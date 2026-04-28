/**
 * Gemini adapter — wraps gemini/client.ts:generateImage() with the
 * uniform ImageGenerator interface.
 *
 * Two adapters are exported (Flash and Pro) because the underlying client
 * picks model via the useProModel boolean rather than a model id string.
 * We bake that decision into the adapter so the registry can list both
 * with distinct ids.
 */

import { generateImage } from '@/lib/gemini/client';
import type { ImageGenerator, UnifiedRequest, UnifiedResult } from './types';

const FLASH_MODEL_ID = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-image-preview').trim();
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

/** Flash provider — default for attempt 0 in most categories. */
export const geminiFlashProvider: ImageGenerator = buildAdapter(FLASH_MODEL_ID, false, 0.045);

/** Pro provider — escalation for retries and complex categories (quilts/cortinas/alfombras). */
export const geminiProProvider: ImageGenerator = buildAdapter(PRO_MODEL_ID, true, 0.134);

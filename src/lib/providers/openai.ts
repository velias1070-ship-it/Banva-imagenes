/**
 * OpenAI adapter — wraps openai/images.ts:generateImageGPT2() with the
 * uniform ImageGenerator interface.
 *
 * Note: GPT-2 requires a hero image (the legacy path was forced to set
 * heroImageBase64 || ''). The adapter preserves that behavior — calling
 * without a hero will produce a hard error from the underlying client.
 */

import { generateImageGPT2 } from '@/lib/openai/images';
import type { ImageGenerator, UnifiedRequest, UnifiedResult } from './types';

const OPENAI_MODEL_ID = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2').trim();

const COST_PER_IMAGE_HIGH = 0.21;
const COST_PER_IMAGE_OTHER = 0.08;

export const gptImage2Provider: ImageGenerator = {
  modelId: OPENAI_MODEL_ID,
  providerFamily: 'openai',
  costPerImageUsd: COST_PER_IMAGE_HIGH,
  async generate(req: UnifiedRequest): Promise<UnifiedResult> {
    const quality = req.hints?.quality ?? 'high';
    const result = await generateImageGPT2({
      heroImageBase64: req.heroImageBase64 || '',
      heroMimeType: req.heroMimeType || 'image/png',
      swatchImageBase64: req.swatchImageBase64,
      swatchMimeType: req.swatchMimeType,
      promptText: req.promptText,
      category: req.category,
      quality,
      size: req.hints?.size,
    });
    const costUsd = result.costEstimateUsd
      ?? (quality === 'high' || quality === 'auto' ? COST_PER_IMAGE_HIGH : COST_PER_IMAGE_OTHER);
    return {
      success: result.success,
      imageBase64: result.imageBase64,
      imageMimeType: result.imageMimeType,
      error: result.error,
      errorCode: result.errorCode,
      durationMs: result.durationMs,
      costUsd,
      modelId: result.modelUsed || OPENAI_MODEL_ID,
      providerFamily: 'openai',
    };
  },
};

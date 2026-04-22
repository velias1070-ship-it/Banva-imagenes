/**
 * Image Provider Router — decide entre Gemini (Nano Banana 2/Pro) y
 * GPT Image 2 según categoría, swatch profile y attempt.
 *
 * Defaults seguros: Gemini (cheap, proven). GPT Image 2 solo se usa con
 * feature flag + criterios específicos (alfombras pattern, cortinas sheer,
 * escalación final post-Pro fail).
 */

import { generateImage, type GeminiGenerateRequest, type GeminiGenerateResult } from '@/lib/gemini/client';
import { generateImageGPT2 } from '@/lib/openai/images';

export type ImageProvider = 'gemini-flash' | 'gemini-pro' | 'gpt-image-2';

export interface ProviderSelectionContext {
  category?: string;
  swatchProfile?: {
    opacity?: 'sheer' | 'translucent' | 'opaque';
    pattern_type?: 'solid' | 'striped' | 'floral' | 'printed_illustration' | string;
    complexity?: 'simple' | 'multi_color' | 'photographic' | string;
  } | null;
  attempt: number;
  useProModel?: boolean;
}

function parseListEnv(name: string): string[] {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Decide el provider a usar según contexto.
 *
 * Reglas (de más específica a más general):
 * 1. Si ENABLE_GPT_IMAGE_2 está off → siempre Gemini (legacy behavior)
 * 2. Si categoría+profile está en lista ALWAYS_GPT_2 → GPT-2 desde attempt 0
 * 3. Si swatch profile indica sheer/translucent → GPT-2 (Gemini falla velos)
 * 4. Si swatch profile indica printed_illustration → GPT-2 (Gemini inventa patterns)
 * 5. Si attempt >= GPT_2_ESCALATION_THRESHOLD → GPT-2 como last resort
 * 6. Default: Gemini Flash/Pro según useProModel
 */
export function selectImageProvider(ctx: ProviderSelectionContext): ImageProvider {
  const gptEnabled = process.env.ENABLE_GPT_IMAGE_2 === '1';

  // 1. Master switch off → legacy Gemini
  if (!gptEnabled) {
    return ctx.useProModel ? 'gemini-pro' : 'gemini-flash';
  }

  // 2. Category/profile-based always-GPT list
  // Format: GPT_IMAGE_2_ALWAYS_FOR="alfombras,cortinas_sheer"
  const alwaysGpt = parseListEnv('GPT_IMAGE_2_ALWAYS_FOR');
  if (ctx.category && alwaysGpt.includes(ctx.category)) {
    return 'gpt-image-2';
  }
  if (ctx.category === 'cortinas' && ctx.swatchProfile?.opacity === 'sheer' && alwaysGpt.includes('cortinas_sheer')) {
    return 'gpt-image-2';
  }

  // 3. Sheer/translucent fabrics — Gemini generates beige linen instead
  if (ctx.swatchProfile?.opacity === 'sheer' || ctx.swatchProfile?.opacity === 'translucent') {
    return 'gpt-image-2';
  }

  // 4. Printed illustration (alfombras ilustradas, sábanas infantiles) —
  //    Gemini invents new patterns instead of reproducing the swatch design
  if (ctx.swatchProfile?.pattern_type === 'printed_illustration' || ctx.swatchProfile?.complexity === 'photographic') {
    return 'gpt-image-2';
  }

  // 5. Escalation: Gemini Flash + Pro both failed — try GPT-2 as last resort
  const escalationThreshold = parseInt(process.env.GPT_IMAGE_2_ESCALATION_THRESHOLD || '2', 10);
  if (ctx.attempt >= escalationThreshold) {
    return 'gpt-image-2';
  }

  // 6. Default Gemini pipeline
  return ctx.useProModel ? 'gemini-pro' : 'gemini-flash';
}

/**
 * Normaliza GPTImageGenResult al formato GeminiGenerateResult para que
 * el caller no necesite cambiar el type.
 */
export async function generateImageSmart(
  req: GeminiGenerateRequest,
  ctx: ProviderSelectionContext,
): Promise<GeminiGenerateResult & { providerUsed: ImageProvider; costEstimateUsd?: number }> {
  const provider = selectImageProvider(ctx);

  if (provider === 'gpt-image-2') {
    const gptResult = await generateImageGPT2({
      heroImageBase64: req.heroImageBase64 || '',
      heroMimeType: req.heroMimeType || 'image/png',
      swatchImageBase64: req.swatchImageBase64,
      swatchMimeType: req.swatchMimeType,
      promptText: req.promptText,
      category: ctx.category,
      quality: 'high',
    });
    // Map to GeminiGenerateResult shape
    return {
      success: gptResult.success,
      imageBase64: gptResult.imageBase64,
      imageMimeType: gptResult.imageMimeType,
      textResponse: undefined,
      error: gptResult.error,
      errorCode: gptResult.errorCode,
      durationMs: gptResult.durationMs,
      meta: { modelName: gptResult.modelUsed } as unknown as GeminiGenerateResult['meta'],
      providerUsed: 'gpt-image-2',
      costEstimateUsd: gptResult.costEstimateUsd,
    };
  }

  // Gemini path (existing)
  const geminiResult = await generateImage({
    ...req,
    useProModel: provider === 'gemini-pro',
  });
  return {
    ...geminiResult,
    providerUsed: provider,
    costEstimateUsd: provider === 'gemini-pro' ? 0.134 : 0.045,
  };
}

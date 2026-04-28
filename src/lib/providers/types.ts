/**
 * Provider abstraction — uniform interface across image generation providers.
 *
 * Adapters (gemini, openai, fal) implement ImageGenerator. The router in
 * image-providers.ts looks up the adapter via MODEL_REGISTRY[modelId] and
 * dispatches to .generate(). Adding a new provider requires:
 *   1. New adapter file in this directory.
 *   2. Entry in src/lib/models/registry.ts.
 *   3. Optional: entry in config/routing-rules.json to route specific
 *      categories/attempts to it.
 *
 * No changes to process-next, results route, multipass, or category-strategy.
 */

import type { GeminiResponseMeta } from '@/lib/gemini/client';

/** Logical provider family (used for routing decisions). */
export type ProviderFamily = 'gemini' | 'openai' | 'fal';

/** Concrete model identifier — opaque string, free to add new ones. */
export type ProviderId = string;

export interface UnifiedRequest {
  heroImageBase64?: string;
  heroMimeType?: string;
  swatchImageBase64: string;
  swatchMimeType: string;
  promptText: string;
  temperature?: number;
  category?: string;
  /** Pass through to the underlying provider when relevant (e.g., GPT-2 size/quality). */
  hints?: {
    quality?: 'low' | 'medium' | 'high' | 'auto';
    size?: '1024x1024' | '1024x1536' | '1536x1024';
  };
}

export interface UnifiedResult {
  success: boolean;
  imageBase64?: string;
  imageMimeType?: string;
  textResponse?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  /** Estimated cost for this generation, in USD. From registry, not from API response. */
  costUsd: number;
  /** The actual model ID used. Always populated, even on failure. */
  modelId: ProviderId;
  /** Provider family that produced the result. Always populated. */
  providerFamily: ProviderFamily;
  /** Provider-specific raw metadata (Gemini meta, OpenAI usage, etc.). Optional. */
  raw?: GeminiResponseMeta | Record<string, unknown>;
}

export interface ImageGenerator {
  /** Concrete model id this adapter wraps (used for registry lookup). */
  modelId: ProviderId;
  /** Provider family for downstream routing decisions. */
  providerFamily: ProviderFamily;
  /** Estimated cost per generation in USD (used for cost cap accounting). */
  costPerImageUsd: number;
  generate(req: UnifiedRequest): Promise<UnifiedResult>;
}

/**
 * Model Registry — single source of truth for which adapter handles each
 * model id, plus metadata used by the router (cost, supported modes,
 * texture grade).
 *
 * Adding a new model:
 *   1. Implement an adapter in src/lib/providers/<provider>.ts
 *   2. Add an entry here mapping the model id to that adapter.
 *   3. (Optional) Reference the id from config/routing-rules.json.
 *
 * Cost values are estimates used for the cost-cap accounting. They are
 * NOT enforced against billing — they're guardrails against runaway
 * escalation chains. Update if upstream pricing changes materially.
 */

import type { ImageGenerator, ProviderId, ProviderFamily } from '@/lib/providers/types';
import { geminiFlashProvider, geminiProProvider } from '@/lib/providers/gemini';
import { gptImage2Provider } from '@/lib/providers/openai';
import { falStubProvider } from '@/lib/providers/fal';

export type GenerationMode = 'edit' | 'reference' | 'from_scratch';

export interface ModelEntry {
  /** Adapter that knows how to call this model. */
  adapter: ImageGenerator;
  /** Provider family — used by router and telemetry. */
  providerFamily: ProviderFamily;
  /** Estimated cost per image in USD. Used for cost-cap accounting. */
  costPerImageUsd: number;
  /** Generation modes this model supports. */
  supports: GenerationMode[];
  /** Texture quality 1-5 (5 = best). Source: research/2026-04-14-ai-image-pipelines-ecommerce-textile.md. */
  textureGrade?: number;
  /** Free-text capability notes for human readers. */
  notes?: string;
}

const FLASH_ID = geminiFlashProvider.modelId;
const PRO_ID = geminiProProvider.modelId;
const GPT2_ID = gptImage2Provider.modelId;

/**
 * Registry keyed by canonical model id (the same id stored in
 * generation_jobs.model_id and referenced from routing-rules.json).
 *
 * The keys also include legacy logical aliases ('gemini-flash',
 * 'gemini-pro', 'gpt-image-2') so existing routing code that thinks
 * in provider buckets still resolves cleanly.
 */
export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  // Concrete ids
  [FLASH_ID]: {
    adapter: geminiFlashProvider,
    providerFamily: 'gemini',
    costPerImageUsd: 0.045,
    supports: ['edit', 'reference', 'from_scratch'],
    textureGrade: 4,
    notes: 'Cheap default. Fails on multi-pattern, light-on-white, sheer fabric, printed illustrations.',
  },
  [PRO_ID]: {
    adapter: geminiProProvider,
    providerFamily: 'gemini',
    costPerImageUsd: 0.134,
    supports: ['edit', 'reference', 'from_scratch'],
    textureGrade: 5,
    notes: 'Escalation target for retries. Better texture preservation than Flash.',
  },
  [GPT2_ID]: {
    adapter: gptImage2Provider,
    providerFamily: 'openai',
    costPerImageUsd: 0.21,
    supports: ['edit', 'reference'],
    textureGrade: 5,
    notes: 'Strong on light colors and printed illustrations; different framing bias than Gemini.',
  },

  // Logical aliases — preserve compatibility with the legacy
  // ImageProvider enum so routing-rules.json can reference either.
  'gemini-flash': {
    adapter: geminiFlashProvider,
    providerFamily: 'gemini',
    costPerImageUsd: 0.045,
    supports: ['edit', 'reference', 'from_scratch'],
    textureGrade: 4,
  },
  'gemini-pro': {
    adapter: geminiProProvider,
    providerFamily: 'gemini',
    costPerImageUsd: 0.134,
    supports: ['edit', 'reference', 'from_scratch'],
    textureGrade: 5,
  },
  'gpt-image-2': {
    adapter: gptImage2Provider,
    providerFamily: 'openai',
    costPerImageUsd: 0.21,
    supports: ['edit', 'reference'],
    textureGrade: 5,
  },

  // Stub — present in registry but unreachable until adapter is implemented.
  'fal-stub': {
    adapter: falStubProvider,
    providerFamily: 'fal',
    costPerImageUsd: 0,
    supports: [],
    notes: 'Placeholder for FLUX/Seedream — calling throws.',
  },
};

export function resolveModelEntry(modelId: ProviderId): ModelEntry {
  const entry = MODEL_REGISTRY[modelId];
  if (!entry) {
    throw new Error(`Unknown model id "${modelId}". Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
  }
  return entry;
}

/**
 * Image Provider Router — picks the next model id from the declarative
 * routing rules and dispatches to the corresponding adapter.
 *
 * Replaces the previous hardcoded switch. The selection logic now lives
 * in config/routing-rules.json (validated by Zod at first load). The
 * generation chain has a cost-cap accumulator that prevents runaway
 * escalation: from attempt 1 onward, if the next provider's estimated
 * cost would push accumulatedCost above max_cost_per_job_usd for the
 * category, the chain stops and the best partial result is returned
 * with cost_capped: true on the meta.
 *
 * Backwards compatibility:
 *   - generateImageSmart(req, ctx) signature unchanged.
 *   - Return shape extended with modelIdUsed and costCapped (both optional).
 *   - The legacy `ImageProvider` enum is preserved for callers that
 *     still type against it.
 *   - The recoverable-error fallback to GPT-2 (billing/rate/internal
 *     errors) is kept verbatim.
 */

import fs from 'fs';
import path from 'path';
import type { GeminiGenerateRequest, GeminiGenerateResult } from '@/lib/gemini/client';
import { MODEL_REGISTRY, resolveModelEntry } from '@/lib/models/registry';
import { RoutingRulesSchema, type RoutingRules } from '@/lib/models/routing-rules.schema';
import type { UnifiedRequest, UnifiedResult, ProviderId } from '@/lib/providers/types';

/** Legacy enum preserved for back-compat with callers that import it. */
export type ImageProvider = 'gemini-flash' | 'gemini-pro' | 'gpt-image-2';

export interface ProviderSelectionContext {
  category?: string;
  shotType?: string;
  swatchProfile?: {
    opacity?: 'sheer' | 'translucent' | 'opaque';
    pattern_type?: 'solid' | 'striped' | 'floral' | 'printed_illustration' | string;
    complexity?: 'simple' | 'multi_color' | 'photographic' | string;
  } | null;
  attempt: number;
  /** Legacy: prefer the Pro Gemini model when GPT-2 isn't picked. */
  useProModel?: boolean;
  /**
   * BENCHMARKING ONLY (Sprint 3 golden set).
   * When set, generateImageSmart skips routing-rules entirely and dispatches
   * the request directly to MODEL_REGISTRY[forcedModelId].adapter. The
   * legacy fallback to GPT-2 is also skipped — the benchmark is supposed
   * to test exactly the model it was told to test.
   * Do NOT use this in production code paths. Routing decisions belong in
   * routing-rules.json, not in callers.
   */
  forcedModelId?: ProviderId;
}

// ──────────────────────────────────────────────────────────────────────
// Routing rules — load + validate once, cache.
// ──────────────────────────────────────────────────────────────────────

let cachedRules: RoutingRules | null = null;

function loadRoutingRules(): RoutingRules {
  if (cachedRules) return cachedRules;
  const candidatePaths = [
    path.join(process.cwd(), 'config', 'routing-rules.json'),
    path.join(process.cwd(), '..', 'config', 'routing-rules.json'),
  ];
  let raw: string | null = null;
  let usedPath = '';
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf-8');
      usedPath = p;
      break;
    }
  }
  if (!raw) {
    throw new Error(`routing-rules.json not found in any of: ${candidatePaths.join(', ')}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`routing-rules.json is not valid JSON (${usedPath}): ${(e as Error).message}`);
  }
  const result = RoutingRulesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`routing-rules.json failed validation (${usedPath}):\n${result.error.message}`);
  }
  cachedRules = result.data;
  return cachedRules;
}

function getMaxCostForCategory(rules: RoutingRules, category: string | undefined): number {
  if (category && typeof rules.max_cost_per_job_usd[category] === 'number') {
    return rules.max_cost_per_job_usd[category];
  }
  return rules.max_cost_per_job_usd.default;
}

/**
 * Resolve the chain of model ids for a given context.
 * Precedence:
 *   1. Category × swatch_override (most specific)
 *   2. Category × shot_types[<shot>].attempts
 *   3. Category × attempts
 *   4. default_chain
 */
function resolveChain(rules: RoutingRules, ctx: ProviderSelectionContext): ProviderId[] {
  const cat = ctx.category ? rules.categories[ctx.category] : undefined;

  if (cat?.swatch_overrides) {
    const opacity = ctx.swatchProfile?.opacity;
    if ((opacity === 'sheer' || opacity === 'translucent') && cat.swatch_overrides[opacity]) {
      return cat.swatch_overrides[opacity]!;
    }
    const pat = ctx.swatchProfile?.pattern_type;
    if (pat === 'printed_illustration' && cat.swatch_overrides.printed_illustration) {
      return cat.swatch_overrides.printed_illustration;
    }
    const complexity = ctx.swatchProfile?.complexity;
    if (complexity === 'photographic' && cat.swatch_overrides.photographic) {
      return cat.swatch_overrides.photographic;
    }
  }

  if (cat?.shot_types && ctx.shotType) {
    const shot = cat.shot_types[ctx.shotType];
    if (shot) return shot.attempts;
  }

  if (cat?.attempts) return cat.attempts;
  return rules.default_chain;
}

/**
 * Pick the model id for a given attempt index. Saturates at the last
 * element if attempt > chain length (so legacy callers passing attempt=99
 * still get a valid id).
 */
export function selectModelId(ctx: ProviderSelectionContext): ProviderId {
  const rules = loadRoutingRules();
  const chain = resolveChain(rules, ctx);
  const idx = Math.min(Math.max(ctx.attempt, 0), chain.length - 1);
  return chain[idx];
}

/**
 * Legacy adapter — keeps the old enum result for callers that still
 * use ImageProvider. Maps the resolved model id back to its provider
 * family (which the legacy code treated as "the provider").
 */
export function selectImageProvider(ctx: ProviderSelectionContext): ImageProvider {
  const id = selectModelId(ctx);
  const entry = resolveModelEntry(id);
  // Map back to legacy enum for callers that still expect it.
  if (entry.providerFamily === 'openai') return 'gpt-image-2';
  if (entry.providerFamily === 'gemini') {
    return id === MODEL_REGISTRY['gemini-pro'].adapter.modelId || /pro/i.test(id) ? 'gemini-pro' : 'gemini-flash';
  }
  // Fall back: anything else is treated as flash for legacy purposes.
  return 'gemini-flash';
}

// ──────────────────────────────────────────────────────────────────────
// generateImageSmart — single-attempt dispatch + cost-capped chain
// ──────────────────────────────────────────────────────────────────────

export interface SmartGenerateExtras {
  providerUsed: ImageProvider;
  costEstimateUsd?: number;
  modelIdUsed: ProviderId;
  costCapped?: boolean;
}

function toGeminiResult(u: UnifiedResult): GeminiGenerateResult {
  return {
    success: u.success,
    imageBase64: u.imageBase64,
    imageMimeType: u.imageMimeType,
    textResponse: u.textResponse,
    error: u.error,
    errorCode: u.errorCode,
    durationMs: u.durationMs,
    meta: (u.raw as GeminiGenerateResult['meta']) || { modelUsed: u.modelId },
  };
}

function toUnifiedRequest(req: GeminiGenerateRequest, category?: string): UnifiedRequest {
  return {
    heroImageBase64: req.heroImageBase64,
    heroMimeType: req.heroMimeType,
    swatchImageBase64: req.swatchImageBase64,
    swatchMimeType: req.swatchMimeType,
    promptText: req.promptText,
    temperature: req.temperature,
    category,
  };
}

function familyToLegacyProvider(family: string, modelId: ProviderId): ImageProvider {
  if (family === 'openai') return 'gpt-image-2';
  if (family === 'gemini') {
    return /pro/i.test(modelId) ? 'gemini-pro' : 'gemini-flash';
  }
  return 'gemini-flash';
}

const RECOVERABLE_PATTERNS = [
  'spending cap',
  'billing',
  'resource_exhausted',
  'resource exhausted',
  'rate limit',
  'internal error',
  'quota exceeded',
];

function isRecoverable(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return RECOVERABLE_PATTERNS.some(p => lower.includes(p));
}

/**
 * Generate one image. Picks the model id from routing rules at the given
 * attempt, dispatches to its adapter. If the chosen Gemini model fails
 * with a recoverable error, transparently falls back to GPT-2 (preserves
 * the previous safety net at lines 118-152 of the legacy file).
 *
 * Returns the result in the legacy GeminiGenerateResult shape with
 * provider/cost/model_id telemetry tagged on.
 */
export async function generateImageSmart(
  req: GeminiGenerateRequest,
  ctx: ProviderSelectionContext,
): Promise<GeminiGenerateResult & SmartGenerateExtras> {
  // forcedModelId (Sprint 3 golden set) bypasses routing AND the GPT-2
  // safety-net fallback. Benchmark callers must see the result of the
  // model they asked for, not a recovery substitute.
  const modelId = ctx.forcedModelId ?? selectModelId(ctx);
  const entry = resolveModelEntry(modelId);
  const unifiedReq = toUnifiedRequest(req, ctx.category);

  const result = await entry.adapter.generate(unifiedReq);
  const legacyProvider = familyToLegacyProvider(entry.providerFamily, modelId);

  // Recoverable-error fallback to GPT-2 — preserve the existing safety net.
  // Only triggers when the failed attempt was a Gemini model AND ENABLE_GPT_IMAGE_2=1.
  // Skipped under forcedModelId so benchmarks measure the requested model.
  if (
    !ctx.forcedModelId
    && !result.success
    && entry.providerFamily === 'gemini'
    && process.env.ENABLE_GPT_IMAGE_2 === '1'
    && isRecoverable(result.error)
    && req.heroImageBase64
  ) {
    const gpt2Entry = MODEL_REGISTRY['gpt-image-2'];
    if (gpt2Entry) {
      const fallback = await gpt2Entry.adapter.generate(unifiedReq);
      if (fallback.success) {
        const merged = toGeminiResult(fallback);
        merged.durationMs = (result.durationMs || 0) + fallback.durationMs;
        return {
          ...merged,
          providerUsed: 'gpt-image-2',
          costEstimateUsd: fallback.costUsd,
          modelIdUsed: fallback.modelId,
        };
      }
    }
  }

  return {
    ...toGeminiResult(result),
    providerUsed: legacyProvider,
    costEstimateUsd: result.costUsd,
    modelIdUsed: result.modelId,
  };
}

/**
 * Multi-attempt chain with cost cap. Iterates the routing chain starting
 * at ctx.attempt and stops on first success, OR when the cost cap would
 * be exceeded by the NEXT attempt (only enforced from attempt >= 1 — the
 * first attempt always runs).
 *
 * Most callers use generateImageSmart() for one attempt and let
 * process-next manage the chain at the job level (with QA / verifier
 * gates between attempts). This helper is for callers who want to burn
 * through a chain in a single invocation (golden tests, brand flow).
 */
export async function generateImageWithChain(
  req: GeminiGenerateRequest,
  ctx: ProviderSelectionContext,
): Promise<GeminiGenerateResult & SmartGenerateExtras & { attemptsMade: number }> {
  const rules = loadRoutingRules();
  const chain = resolveChain(rules, ctx);
  const maxCost = getMaxCostForCategory(rules, ctx.category);
  const startAttempt = Math.max(ctx.attempt, 0);

  let accumulatedCost = 0;
  let bestResult: (GeminiGenerateResult & SmartGenerateExtras) | null = null;
  let attemptsMade = 0;

  for (let i = startAttempt; i < chain.length; i++) {
    const modelId = chain[i];
    const entry = resolveModelEntry(modelId);
    const projectedCost = accumulatedCost + entry.costPerImageUsd;

    // Cost cap: only enforced from attempt >= 1; attempt 0 always runs.
    if (i > 0 && projectedCost > maxCost) {
      if (bestResult) {
        return { ...bestResult, costCapped: true, attemptsMade };
      }
      // Should not be reachable given attempt 0 always runs and bestResult is set there.
      break;
    }

    const result = await generateImageSmart(req, { ...ctx, attempt: i });
    accumulatedCost += result.costEstimateUsd ?? entry.costPerImageUsd;
    attemptsMade++;
    if (!bestResult || result.success) bestResult = result;
    if (result.success) return { ...result, attemptsMade };
  }

  if (!bestResult) {
    // Should never happen — chain always has at least one element by Zod schema.
    throw new Error('generateImageWithChain: empty chain');
  }
  return { ...bestResult, attemptsMade };
}

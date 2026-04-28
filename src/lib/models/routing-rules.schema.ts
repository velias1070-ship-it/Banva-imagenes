/**
 * Zod schema for config/routing-rules.json. Validated at first import in
 * runtime; a typo in the JSON throws with a readable error before the
 * router can produce surprising behavior.
 *
 * Shape:
 *   {
 *     "default_chain": ["model_id_attempt_0", "model_id_attempt_1", ...],
 *     "categories": {
 *       "<category>": {
 *         "shot_types": {
 *           "<shot_type>": { "attempts": ["model_id_0", ...] }
 *         },
 *         "swatch_overrides": {
 *           "sheer":                  ["model_id_0", ...],
 *           "translucent":            ["model_id_0", ...],
 *           "printed_illustration":   ["model_id_0", ...],
 *           "photographic":           ["model_id_0", ...]
 *         },
 *         "attempts": ["model_id_0", ...]   // category-level fallback
 *       }
 *     },
 *     "max_cost_per_job_usd": { "default": 0.30, "<category>": 0.50 }
 *   }
 */

import { z } from 'zod';
import { MODEL_REGISTRY } from './registry';

const KnownModelIds = Object.keys(MODEL_REGISTRY);

function modelIdRefinement(value: string, ctx: z.RefinementCtx) {
  if (!KnownModelIds.includes(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown model id "${value}". Known: ${KnownModelIds.join(', ')}`,
    });
  }
}

const ModelId = z.string().superRefine(modelIdRefinement);
const Chain = z.array(ModelId).min(1);

const SwatchOverrides = z
  .object({
    sheer: Chain.optional(),
    translucent: Chain.optional(),
    printed_illustration: Chain.optional(),
    photographic: Chain.optional(),
  })
  .partial();

const CategoryRule = z.object({
  attempts: Chain.optional(),
  shot_types: z.record(z.string(), z.object({ attempts: Chain })).optional(),
  swatch_overrides: SwatchOverrides.optional(),
  _review_when: z.string().optional(),
  _decision_basis: z.string().optional(),
});

export const RoutingRulesSchema = z.object({
  default_chain: Chain,
  categories: z.record(z.string(), CategoryRule).default({}),
  max_cost_per_job_usd: z
    .object({ default: z.number().positive() })
    .catchall(z.number().positive()),
});

export type RoutingRules = z.infer<typeof RoutingRulesSchema>;

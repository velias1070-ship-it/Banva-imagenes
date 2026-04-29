/**
 * Per-job cost cap enforcement — Sprint 2 issue #3.
 *
 * The cost cap exists in routing-rules.json as max_cost_per_job_usd. Until
 * now it was only honored by generateImageWithChain() — a helper used by
 * golden tests and the brand flow that burns the full chain in one
 * invocation. The runtime path (process-next + results/[jobId]) never
 * checked the cap, so a single job could rack up $1.20+ in retries on
 * persistent quality failures (verifier reject loops on Pro).
 *
 * This module adds a job-level guard: before each attempt, sum the cost
 * of all PRIOR attempts (from pipeline_log PROVIDER_USED events), add the
 * projected cost of the next attempt, and abort if the projection exceeds
 * the category's cap.
 *
 * Design choices (per Sprint 2 issue #3 plan):
 *   - Source of truth is pipeline_log PROVIDER_USED events. The
 *     generation_jobs.cost_usd_actual column overwrites on every attempt,
 *     so it cannot be summed.
 *   - On cap hit: status = 'flagged' (NOT 'error') so the job stays
 *     reviewable in the UI. error path hides them as technical failures.
 *     prompt_metadata.cost_capped = true for fast queries.
 *   - Attempt 0 is exempt: a job must always get at least one shot.
 *
 * TODO Sprint 3 final: cost_usd_actual se sobrescribe por attempt en vez
 *   de acumular. Considerar refactor a columna acumulativa
 *   (cost_usd_total) + agregar last_attempt_cost_usd separada. Ahora
 *   sumamos desde pipeline_log JSONB, funciona pero es más caro que SUM
 *   sobre columna indexada.
 */

import fs from 'fs';
import path from 'path';

interface PipelineLogEntry {
  event: string;
  data?: string | Record<string, unknown> | null;
}

const ROUTING_RULES_PATH = path.join(process.cwd(), 'config', 'routing-rules.json');
let cachedCostCaps: Record<string, number> | null = null;

function loadCostCaps(): Record<string, number> {
  if (cachedCostCaps) return cachedCostCaps;
  const raw = fs.readFileSync(ROUTING_RULES_PATH, 'utf-8');
  const rules = JSON.parse(raw) as { max_cost_per_job_usd: Record<string, number> };
  cachedCostCaps = rules.max_cost_per_job_usd;
  return cachedCostCaps;
}

/**
 * Resolve the per-job cost cap for a category. Falls back to the 'default'
 * key in routing-rules.json when the category is unknown or unset.
 */
export function getCostCapForCategory(category: string | null | undefined): number {
  const caps = loadCostCaps();
  if (category && typeof caps[category] === 'number') return caps[category];
  return caps.default;
}

/**
 * Sum cost_usd from every PROVIDER_USED entry in a pipeline_log array.
 * Pure function — pipeline_log is the JSONB column on generation_jobs.
 *
 * Matches both data shapes used in the codebase:
 *   { event: 'PROVIDER_USED', data: { cost_usd: 0.045, model_id: '...' } }
 *   { event: 'PROVIDER_USED', data: '{"cost_usd":0.045,...}' }   // older
 */
export function sumJobCostFromPipelineLog(
  pipelineLog: PipelineLogEntry[] | null | undefined,
): number {
  if (!pipelineLog || pipelineLog.length === 0) return 0;
  let total = 0;
  for (const entry of pipelineLog) {
    if (entry.event !== 'PROVIDER_USED') continue;
    let costUsd: unknown;
    if (typeof entry.data === 'string') {
      try {
        const parsed = JSON.parse(entry.data) as { cost_usd?: unknown };
        costUsd = parsed.cost_usd;
      } catch {
        continue;
      }
    } else if (entry.data && typeof entry.data === 'object') {
      costUsd = (entry.data as { cost_usd?: unknown }).cost_usd;
    }
    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) {
      total += costUsd;
    }
  }
  return total;
}

export interface CostCapDecision {
  enforced: boolean;
  exceeded: boolean;
  accumulatedUsd: number;
  projectedUsd: number;
  capUsd: number;
}

// FP epsilon — jobs whose projection lands within 1¢ of the cap should not
// trip the guard. 0.2 + 0.1 = 0.30000000000000004 in JS, and we don't want
// that to flag a cap of 0.30.
const COST_CAP_EPSILON_USD = 0.01;

/**
 * Decide whether the next attempt would exceed the cap. Pure function —
 * no I/O, no DB. Attempt 0 is exempt (enforced=false) because a job must
 * always get at least one shot.
 */
export function evaluateCostCap(input: {
  attempt: number;
  accumulatedUsd: number;
  projectedNextUsd: number;
  capUsd: number;
}): CostCapDecision {
  const { attempt, accumulatedUsd, projectedNextUsd, capUsd } = input;
  const projected = accumulatedUsd + projectedNextUsd;
  if (attempt < 1) {
    return { enforced: false, exceeded: false, accumulatedUsd, projectedUsd: projected, capUsd };
  }
  return {
    enforced: true,
    exceeded: projected > capUsd + COST_CAP_EPSILON_USD,
    accumulatedUsd,
    projectedUsd: projected,
    capUsd,
  };
}

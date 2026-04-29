/**
 * Golden run comparator — Sprint 3.
 *
 * Pure logic for diff'ing two golden_runs (a `base` run vs an `against`
 * run). Produces per-case diffs, classifies regressions and improvements,
 * and emits an adoption recommendation.
 *
 * Used by scripts/compare-golden-runs.ts (which is the I/O layer that
 * fetches the rows and prints markdown).
 */

export interface GoldenRow {
  run_id: string;
  case_id: string;
  model_id_tested: string;
  score_total: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  run_metadata: Record<string, unknown> | null;
}

export interface CaseDiff {
  case_id: string;
  base_score: number | null;
  against_score: number | null;
  base_cost: number | null;
  against_cost: number | null;
  base_duration: number | null;
  against_duration: number | null;
  score_delta: number | null;        // against - base (positive = improvement)
  cost_delta: number | null;         // against - base (negative = cheaper)
  duration_delta: number | null;     // against - base (negative = faster)
  classification: 'regression' | 'improvement' | 'parity' | 'missing_in_base' | 'missing_in_against' | 'both_failed';
}

export interface ComparisonResult {
  base_model: string | null;
  against_model: string | null;
  total_cases: number;
  regressions: CaseDiff[];
  improvements: CaseDiff[];
  parity: CaseDiff[];
  missing: CaseDiff[];
  totals: {
    base_cost_usd: number;
    against_cost_usd: number;
    cost_delta_usd: number;
    base_avg_duration_ms: number | null;
    against_avg_duration_ms: number | null;
  };
  recommendation: 'ADOPT' | 'DO_NOT_ADOPT' | 'PARTIAL';
  recommendation_reason: string;
}

/**
 * Default thresholds — chosen to match the regression-alert cron from
 * Sprint 2 issue #5 (>=15pp drop = regression). Comparator uses score
 * fractions, so 0.10 here = 10pp.
 */
const DEFAULT_REGRESSION_THRESHOLD = 0.10;
const DEFAULT_IMPROVEMENT_THRESHOLD = 0.05;

export interface CompareOptions {
  regressionThreshold?: number;
  improvementThreshold?: number;
}

function classify(
  baseScore: number | null,
  againstScore: number | null,
  regrTh: number,
  imprTh: number,
): CaseDiff['classification'] {
  if (baseScore === null && againstScore === null) return 'both_failed';
  if (baseScore === null) return 'missing_in_base';
  if (againstScore === null) return 'missing_in_against';
  const delta = againstScore - baseScore;
  if (delta <= -regrTh) return 'regression';
  if (delta >= imprTh) return 'improvement';
  return 'parity';
}

function safeDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function avg(nums: Array<number | null>): number | null {
  const valid = nums.filter((n): n is number => n !== null && Number.isFinite(n));
  if (valid.length === 0) return null;
  return valid.reduce((s, n) => s + n, 0) / valid.length;
}

export function compareRuns(
  baseRows: GoldenRow[],
  againstRows: GoldenRow[],
  opts: CompareOptions = {},
): ComparisonResult {
  const regrTh = opts.regressionThreshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const imprTh = opts.improvementThreshold ?? DEFAULT_IMPROVEMENT_THRESHOLD;

  const baseByCase = new Map<string, GoldenRow>();
  for (const r of baseRows) baseByCase.set(r.case_id, r);
  const againstByCase = new Map<string, GoldenRow>();
  for (const r of againstRows) againstByCase.set(r.case_id, r);

  // Union of case ids preserves order from base, then appends new from against.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const r of baseRows) {
    if (!seen.has(r.case_id)) {
      seen.add(r.case_id);
      orderedIds.push(r.case_id);
    }
  }
  for (const r of againstRows) {
    if (!seen.has(r.case_id)) {
      seen.add(r.case_id);
      orderedIds.push(r.case_id);
    }
  }

  const allDiffs: CaseDiff[] = orderedIds.map((id) => {
    const b = baseByCase.get(id) || null;
    const a = againstByCase.get(id) || null;
    const baseScore = b?.score_total ?? null;
    const againstScore = a?.score_total ?? null;
    return {
      case_id: id,
      base_score: baseScore,
      against_score: againstScore,
      base_cost: b?.cost_usd ?? null,
      against_cost: a?.cost_usd ?? null,
      base_duration: b?.duration_ms ?? null,
      against_duration: a?.duration_ms ?? null,
      score_delta: safeDelta(againstScore, baseScore),
      cost_delta: safeDelta(a?.cost_usd ?? null, b?.cost_usd ?? null),
      duration_delta: safeDelta(a?.duration_ms ?? null, b?.duration_ms ?? null),
      classification: classify(baseScore, againstScore, regrTh, imprTh),
    };
  });

  const regressions = allDiffs.filter((d) => d.classification === 'regression');
  const improvements = allDiffs.filter((d) => d.classification === 'improvement');
  const parity = allDiffs.filter((d) => d.classification === 'parity');
  const missing = allDiffs.filter((d) => d.classification === 'missing_in_base' || d.classification === 'missing_in_against' || d.classification === 'both_failed');

  const baseCost = baseRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const againstCost = againstRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const baseAvgDuration = avg(baseRows.map((r) => r.duration_ms));
  const againstAvgDuration = avg(againstRows.map((r) => r.duration_ms));

  // Recommendation logic:
  //   ADOPT       — zero regressions AND (improvements > 0 OR cost delta <= 0)
  //   DO_NOT_ADOPT — at least 1 regression AND no improvements
  //   PARTIAL     — mixed (regressions > 0 AND improvements > 0), or no
  //                 regressions but cost increased without improvements
  let recommendation: ComparisonResult['recommendation'];
  let reason: string;
  if (regressions.length === 0 && improvements.length > 0) {
    if (againstCost > baseCost) {
      recommendation = 'ADOPT';
      reason = `${improvements.length} improvement(s), 0 regressions. Cost increased $${(againstCost - baseCost).toFixed(3)} but no quality loss.`;
    } else {
      recommendation = 'ADOPT';
      reason = `${improvements.length} improvement(s), 0 regressions, cost ${againstCost <= baseCost ? 'lower or equal' : 'similar'}.`;
    }
  } else if (regressions.length === 0 && improvements.length === 0) {
    if (againstCost < baseCost) {
      recommendation = 'ADOPT';
      reason = `Quality parity, cost down $${(baseCost - againstCost).toFixed(3)}.`;
    } else if (againstCost > baseCost) {
      recommendation = 'DO_NOT_ADOPT';
      reason = `Quality parity but cost up $${(againstCost - baseCost).toFixed(3)} — no benefit to switching.`;
    } else {
      recommendation = 'DO_NOT_ADOPT';
      reason = 'Quality and cost parity — no reason to switch.';
    }
  } else if (regressions.length > 0 && improvements.length === 0) {
    recommendation = 'DO_NOT_ADOPT';
    reason = `${regressions.length} regression(s), 0 improvements.`;
  } else {
    recommendation = 'PARTIAL';
    reason = `Mixed: ${improvements.length} improvement(s), ${regressions.length} regression(s). Use selectively (e.g., per category override in routing-rules.json).`;
  }

  return {
    base_model: baseRows[0]?.model_id_tested ?? null,
    against_model: againstRows[0]?.model_id_tested ?? null,
    total_cases: orderedIds.length,
    regressions,
    improvements,
    parity,
    missing,
    totals: {
      base_cost_usd: baseCost,
      against_cost_usd: againstCost,
      cost_delta_usd: againstCost - baseCost,
      base_avg_duration_ms: baseAvgDuration,
      against_avg_duration_ms: againstAvgDuration,
    },
    recommendation,
    recommendation_reason: reason,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Markdown rendering — used by the CLI but pure (no I/O).
// ─────────────────────────────────────────────────────────────────────

function fmtScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(3);
}
function fmtPct(n: number | null): string {
  if (n === null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}pp`;
}
function fmtCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(3)}`;
}
function fmtMs(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(0)}ms`;
}

export function renderMarkdown(result: ComparisonResult, baseRunId: string, againstRunId: string): string {
  const lines: string[] = [];
  lines.push(`# Golden Run Comparison`);
  lines.push('');
  lines.push(`- **base**: \`${baseRunId}\` (${result.base_model || 'unknown'})`);
  lines.push(`- **against**: \`${againstRunId}\` (${result.against_model || 'unknown'})`);
  lines.push(`- **total cases**: ${result.total_cases}`);
  lines.push('');
  lines.push(`## Recommendation: **${result.recommendation}**`);
  lines.push('');
  lines.push(`> ${result.recommendation_reason}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | base | against | delta |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Total cost | ${fmtCost(result.totals.base_cost_usd)} | ${fmtCost(result.totals.against_cost_usd)} | ${fmtCost(result.totals.cost_delta_usd)} |`);
  lines.push(`| Avg duration | ${fmtMs(result.totals.base_avg_duration_ms)} | ${fmtMs(result.totals.against_avg_duration_ms)} | ${fmtMs(result.totals.against_avg_duration_ms !== null && result.totals.base_avg_duration_ms !== null ? result.totals.against_avg_duration_ms - result.totals.base_avg_duration_ms : null)} |`);
  lines.push(`| Regressions | — | — | ${result.regressions.length} |`);
  lines.push(`| Improvements | — | — | ${result.improvements.length} |`);
  lines.push(`| Parity | — | — | ${result.parity.length} |`);
  lines.push(`| Missing/failed | — | — | ${result.missing.length} |`);
  lines.push('');

  function section(title: string, diffs: CaseDiff[]) {
    if (diffs.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`| case_id | base score | against score | Δ score | base $ | against $ | Δ $ |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
    for (const d of diffs) {
      lines.push(`| ${d.case_id} | ${fmtScore(d.base_score)} | ${fmtScore(d.against_score)} | ${fmtPct(d.score_delta)} | ${fmtCost(d.base_cost)} | ${fmtCost(d.against_cost)} | ${fmtCost(d.cost_delta)} |`);
    }
    lines.push('');
  }

  section('Regressions', result.regressions);
  section('Improvements', result.improvements);
  section('Parity', result.parity);
  section('Missing / both-failed', result.missing);

  return lines.join('\n');
}

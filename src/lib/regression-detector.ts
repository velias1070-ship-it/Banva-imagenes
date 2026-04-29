/**
 * Regression detector — Sprint 2 issue #5.
 *
 * Pure logic for detecting approval-rate drops on a rolling window. The
 * cron route loads the last N jobs per model_id, calls detectRegression()
 * for each, and fires a webhook when the rolling rate diverges from the
 * baseline by more than the configured threshold.
 *
 * Definitions:
 *   - approval_rate(jobs) = approved / (approved + flagged + error)
 *     (jobs in 'pending'/'generating'/etc don't count yet — we only score
 *     terminal states)
 *   - baseline = approval_rate over WINDOW_OLDER_HALF (oldest 50 of 100)
 *   - rolling  = approval_rate over WINDOW_NEWER_HALF (newest 50 of 100)
 *   - regression iff baseline >= MIN_BASELINE AND
 *                   (baseline - rolling) >= DROP_PP_THRESHOLD
 *
 * Why baseline >= MIN_BASELINE: alfombras-style "always 0%" buckets aren't
 * regressions — they're priors. Don't alert on conditions that were never
 * working.
 */

export interface JobOutcome {
  status: 'approved' | 'flagged' | 'error' | string;
  created_at: string;
}

export interface RegressionInput {
  modelId: string;
  caseSignature: string | null;
  jobs: JobOutcome[];
  /** Default 0.15 = 15 percentage-point drop. */
  dropPpThreshold?: number;
  /** Default 0.50 = baseline must be >=50% to count as a regression. */
  minBaseline?: number;
}

export interface RegressionResult {
  modelId: string;
  caseSignature: string | null;
  total: number;
  baselineApprovalRate: number | null;
  rollingApprovalRate: number | null;
  dropPp: number | null;
  isRegression: boolean;
  reason: string;
}

const TERMINAL_STATUSES = new Set(['approved', 'flagged', 'error']);

function approvalRate(jobs: JobOutcome[]): number | null {
  const terminal = jobs.filter(j => TERMINAL_STATUSES.has(j.status));
  if (terminal.length === 0) return null;
  const approved = terminal.filter(j => j.status === 'approved').length;
  return approved / terminal.length;
}

export function detectRegression(input: RegressionInput): RegressionResult {
  const dropPpThreshold = input.dropPpThreshold ?? 0.15;
  const minBaseline = input.minBaseline ?? 0.50;
  const total = input.jobs.length;

  // Sort newest → oldest so older half is at the END of the array.
  const sorted = [...input.jobs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const half = Math.floor(sorted.length / 2);
  if (half === 0) {
    return {
      modelId: input.modelId,
      caseSignature: input.caseSignature,
      total,
      baselineApprovalRate: null,
      rollingApprovalRate: null,
      dropPp: null,
      isRegression: false,
      reason: 'insufficient_jobs',
    };
  }

  const newer = sorted.slice(0, half);
  const older = sorted.slice(half);

  const rolling = approvalRate(newer);
  const baseline = approvalRate(older);

  if (baseline === null || rolling === null) {
    return {
      modelId: input.modelId,
      caseSignature: input.caseSignature,
      total,
      baselineApprovalRate: baseline,
      rollingApprovalRate: rolling,
      dropPp: null,
      isRegression: false,
      reason: 'no_terminal_jobs_in_window',
    };
  }

  const dropPp = baseline - rolling;

  if (baseline < minBaseline) {
    return {
      modelId: input.modelId,
      caseSignature: input.caseSignature,
      total,
      baselineApprovalRate: baseline,
      rollingApprovalRate: rolling,
      dropPp,
      isRegression: false,
      reason: 'baseline_below_min',
    };
  }

  if (dropPp >= dropPpThreshold) {
    return {
      modelId: input.modelId,
      caseSignature: input.caseSignature,
      total,
      baselineApprovalRate: baseline,
      rollingApprovalRate: rolling,
      dropPp,
      isRegression: true,
      reason: 'drop_exceeds_threshold',
    };
  }

  return {
    modelId: input.modelId,
    caseSignature: input.caseSignature,
    total,
    baselineApprovalRate: baseline,
    rollingApprovalRate: rolling,
    dropPp,
    isRegression: false,
    reason: 'within_tolerance',
  };
}

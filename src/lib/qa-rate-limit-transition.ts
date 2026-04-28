/**
 * Pure helper that decides what UPDATE payload process-qa should write to a
 * job after a QA scoring failure. Extracted from the catch block so the
 * branching logic is testable without DB / Vercel / Gemini in scope.
 *
 * Spec (Sprint 2 issue #1):
 *   - Non-429 errors → reset to 'qa_pending' (legacy behavior, retry by chain).
 *   - 429-style errors (Resource Exhausted / quota / rate limit / HTTP 429)
 *     → status='qa_rate_limited', next_retry_at = now + backoff(retry_n).
 *   - After 24h cumulative time in this rate-limit loop, a new failed retry
 *     terminates the job with status='error'.
 *
 * Backoff schedule (cron-driven, no sleep):
 *   retry 1 → 30s
 *   retry 2 → 2min
 *   retry 3 → 10min
 *   retry 4 → 30min
 *   retry 5+ → 60min
 *
 * Telemetry written to prompt_metadata.rate_limit_history (append-only array)
 * for full audit trail when the job eventually closes (approved/error).
 *
 * Caller is responsible for the supabase.update() call. This helper is
 * synchronous and side-effect free.
 */

export interface RateLimitHistoryEntry {
  retry_n: number;
  attempted_at: string;          // ISO timestamp
  error_msg: string;             // truncated to 200 chars
  next_retry_at: string;         // ISO timestamp
  wait_minutes: number;          // backoff applied for this retry
  hours_in_loop: number;         // total hours since first 429 attempt
}

export interface QATransitionInput {
  promptMetadata: Record<string, unknown> | null;
  errorMessage: string;
  now?: Date;                    // injectable for testing
}

export type QATransitionOutput =
  | {
      kind: 'rate_limit_deferred';
      update: {
        status: 'qa_rate_limited';
        next_retry_at: string;
        error_message: string;
        prompt_metadata: Record<string, unknown>;
        total_429_retries: number;
        updated_at: string;
      };
      newHistoryEntry: RateLimitHistoryEntry;
    }
  | {
      kind: 'rate_limit_exhausted';
      update: {
        status: 'error';
        next_retry_at: null;
        error_message: string;
        prompt_metadata: Record<string, unknown>;
        total_429_retries: number;
        updated_at: string;
      };
      newHistoryEntry: RateLimitHistoryEntry;
      hoursInLoop: number;
    }
  | {
      kind: 'non_rate_limit';
      update: {
        status: 'qa_pending';
        error_message: string;
        updated_at: string;
      };
    };

// Backoff schedule (minutes). Saturates at the last entry for retries beyond.
const BACKOFF_MIN = [0.5, 2, 10, 30, 60];

// Hard cap: total time the same job is allowed to bounce between rate_limited
// and qa_pending before we declare it terminal.
const MAX_HOURS_IN_LOOP = 24;

// Pattern matches Gemini's 'Resource Exhausted', generic '429', and rate-limit
// phrasing. Tested against actual error_message strings observed in pipeline_log.
const RATE_LIMIT_RE = /resource.{0,5}exhausted|rate.{0,5}limit|quota.{0,5}exceeded|\b429\b/i;

export function isRateLimitError(errorMessage: string): boolean {
  return RATE_LIMIT_RE.test(errorMessage);
}

export function computeQAErrorTransition(input: QATransitionInput): QATransitionOutput {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  if (!isRateLimitError(input.errorMessage)) {
    return {
      kind: 'non_rate_limit',
      update: {
        status: 'qa_pending',
        error_message: `QA error: ${input.errorMessage}`,
        updated_at: nowIso,
      },
    };
  }

  const meta = input.promptMetadata ?? {};
  const history = Array.isArray(meta.rate_limit_history)
    ? (meta.rate_limit_history as RateLimitHistoryEntry[])
    : [];
  const retryN = history.length + 1;

  const waitMinutes = BACKOFF_MIN[Math.min(retryN - 1, BACKOFF_MIN.length - 1)];
  const nextRetryAt = new Date(now.getTime() + waitMinutes * 60_000).toISOString();

  const firstAttemptIso = history[0]?.attempted_at;
  const hoursInLoop = firstAttemptIso
    ? (now.getTime() - new Date(firstAttemptIso).getTime()) / 3_600_000
    : 0;

  const newHistoryEntry: RateLimitHistoryEntry = {
    retry_n: retryN,
    attempted_at: nowIso,
    error_msg: input.errorMessage.slice(0, 200),
    next_retry_at: nextRetryAt,
    wait_minutes: waitMinutes,
    hours_in_loop: hoursInLoop,
  };

  if (hoursInLoop >= MAX_HOURS_IN_LOOP) {
    return {
      kind: 'rate_limit_exhausted',
      hoursInLoop,
      newHistoryEntry,
      update: {
        status: 'error',
        next_retry_at: null,
        error_message: `Gemini 429 unrecovered for ${hoursInLoop.toFixed(1)}h after ${retryN} retries. Manual intervention required.`,
        prompt_metadata: { ...meta, rate_limit_history: [...history, newHistoryEntry] },
        total_429_retries: retryN,
        updated_at: nowIso,
      },
    };
  }

  return {
    kind: 'rate_limit_deferred',
    newHistoryEntry,
    update: {
      status: 'qa_rate_limited',
      next_retry_at: nextRetryAt,
      error_message: `Gemini 429 retry ${retryN} (waited ${waitMinutes}min, next at ${nextRetryAt})`,
      prompt_metadata: { ...meta, rate_limit_history: [...history, newHistoryEntry] },
      total_429_retries: retryN,
      updated_at: nowIso,
    },
  };
}

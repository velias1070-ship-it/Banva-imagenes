-- Migration 008: rate-limit recovery columns + indexes (additive)
--
-- Why: process-qa catch (issue #1) treats every QA error as retry-able and
-- resets to 'qa_pending' immediately, creating a tight retry loop on Gemini
-- 429 (Resource Exhausted). The loop refreshes updated_at constantly so the
-- 60s stale threshold never fires, and consumes Vercel invocations until the
-- quota is released externally.
--
-- Sprint 2 fix: catch detects 429 patterns, computes a cron-driven backoff,
-- writes status='qa_rate_limited' with next_retry_at, and exits. A new cron
-- /api/cron/retry-rate-limited (every 10 min) promotes ready jobs back to
-- qa_pending. The daily health-check has a defense-in-depth branch that
-- rescues qa_rate_limited >1h overdue.
--
-- Schema changes:
--   - next_retry_at TIMESTAMPTZ NULL  — when the cron should re-promote
--   - total_429_retries INT          — aggregate count for fast queries
--   - 'qa_rate_limited' is a NEW status value (string column, no enum DDL)
--
-- Backfill: none. Columns are nullable / default 0. Existing rows untouched.

BEGIN;

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS total_429_retries INT NOT NULL DEFAULT 0;

-- Cron query path: WHERE status='qa_rate_limited' AND next_retry_at < NOW()
CREATE INDEX IF NOT EXISTS idx_generation_jobs_rate_limited_next
  ON generation_jobs(next_retry_at)
  WHERE status = 'qa_rate_limited';

-- Bonus pass for zombie cleanup: WHERE status='qa_pending' AND updated_at < NOW() - 1h
CREATE INDEX IF NOT EXISTS idx_generation_jobs_qa_pending_stale
  ON generation_jobs(updated_at)
  WHERE status = 'qa_pending';

-- Telemetry helper index for "how many 429s in the last 24h" type queries
CREATE INDEX IF NOT EXISTS idx_generation_jobs_total_429_retries
  ON generation_jobs(total_429_retries)
  WHERE total_429_retries > 0;

COMMIT;

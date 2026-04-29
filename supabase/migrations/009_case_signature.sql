-- Migration 009: case_signature TEXT column for telemetry grouping
-- Sprint 2 issue #2.
--
-- model_performance (Sprint 2 issue #4) groups by (provider_used,
-- case_signature, attempt). Without a stable case-key there's no way to
-- distinguish "Flash struggles on sheer cortinas" from "Flash succeeds on
-- opaque sabanas" — overall averages hide the regression.
--
-- Format: <category>:<shot_type>:<pattern_relation>:<darkness>[:<opacity>]
--   sabanas:lifestyle:multipattern:dark
--   quilts:main:samepattern:light
--   cortinas:lifestyle:unknownpattern:light:sheer
--
-- See src/lib/case-signature.ts for the canonical formatter.

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS case_signature TEXT;

COMMENT ON COLUMN generation_jobs.case_signature IS
  'Stable telemetry key. Format: <category>:<shot_type>:<pattern>:<darkness>[:<opacity>]. Built by src/lib/case-signature.ts buildCaseSignature(). Persisted at job creation/update; backfilled best-effort by scripts/backfill-case-signature.ts.';

-- Partial index for model_performance materialized-view queries. Excludes
-- nulls so the index stays small while we backfill.
CREATE INDEX IF NOT EXISTS idx_generation_jobs_case_signature
  ON generation_jobs (case_signature)
  WHERE case_signature IS NOT NULL;

-- Composite index for the common Sprint 2 issue #4 query path:
--   SELECT provider_used, case_signature, attempt, AVG(qa_score), COUNT(*)
--   FROM generation_jobs
--   WHERE case_signature IS NOT NULL AND status IN ('approved','flagged','error')
--   GROUP BY provider_used, case_signature, attempt;
CREATE INDEX IF NOT EXISTS idx_generation_jobs_perf_grouping
  ON generation_jobs (provider_used, case_signature, attempt)
  WHERE case_signature IS NOT NULL AND status IN ('approved', 'flagged', 'error');

DO $$
BEGIN
  RAISE NOTICE '[009] case_signature column + 2 partial indexes created';
END $$;

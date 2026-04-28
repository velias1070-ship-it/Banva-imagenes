-- Migration 007: provider telemetry columns + best-effort backfill (additive)
--
-- Why: gemini_model_used lies when GPT-2 (or any non-Gemini provider) is used —
-- process-next:1311 and results/[jobId]:1324 hardcode it to GEMINI_MODEL_PRO/GEMINI_MODEL
-- regardless of which provider actually generated the image. The truth lives only in
-- pipeline_log JSONB (not queryable). This migration:
--   1. Adds queryable columns: provider_used, model_id, cost_usd_actual, _telemetry_source
--   2. Backfills from pipeline_log PROVIDER_USED events (sprint_1_runtime tag)
--   3. Falls back to pattern matching gemini_model_used (backfill_inferred tag)
--   4. Reports coverage but DOES NOT block — additive migration is safe by design
--   5. KEEPS gemini_model_used column for 2-3 months until confidence in new columns
--
-- ROUTE B (additive): no destructive DROP. The legacy column stays as a fallback
-- and audit trail. A future migration drops it after >30 days of clean telemetry.
--
-- IMPORTANT shape note: PROVIDER_USED events are logged as:
--   logPipelineEvent(job.id, 'PROVIDER_USED', smart.providerUsed, { cost_usd, model_id })
-- which the helper writes as { ts, event:'PROVIDER_USED', detail:'<provider>', data:{cost_usd, model_id} }.
-- So provider lives in event->>'detail', cost+model_id in event->'data'->>'<key>'.
--
-- _telemetry_source values:
--   'sprint_1_runtime'    : populated from PROVIDER_USED event (high confidence)
--   'backfill_inferred'   : pattern-matched from gemini_model_used (medium confidence)
--   NULL                  : no signal available (legacy job, irrecoverable)

BEGIN;

-- Step 1: ADD COLUMN (additive only, no DROP)
ALTER TABLE generation_jobs
  ADD COLUMN provider_used TEXT,
  ADD COLUMN model_id TEXT,
  ADD COLUMN cost_usd_actual DECIMAL(8,4),
  ADD COLUMN _telemetry_source TEXT;

-- Step 2: PRIMARY BACKFILL — from pipeline_log PROVIDER_USED events.
-- Take the LAST PROVIDER_USED event per job (latest attempt's truth).
-- This is the high-confidence path: events written by Sprint 1 runtime.
WITH last_provider AS (
  SELECT DISTINCT ON (gj.id)
    gj.id AS job_id,
    ev->>'detail' AS provider_used,
    NULLIF(ev->'data'->>'cost_usd', '')::DECIMAL(8,4) AS cost_usd_actual,
    NULLIF(ev->'data'->>'model_id', '') AS model_id_event
  FROM generation_jobs gj,
       LATERAL jsonb_array_elements(COALESCE(gj.pipeline_log, '[]'::jsonb)) AS ev
  WHERE ev->>'event' = 'PROVIDER_USED'
  ORDER BY gj.id, (ev->>'ts') DESC
)
UPDATE generation_jobs gj
SET provider_used     = lp.provider_used,
    cost_usd_actual   = lp.cost_usd_actual,
    model_id          = COALESCE(NULLIF(btrim(lp.model_id_event, E' \t\n\r'), ''), btrim(gj.gemini_model_used, E' \t\n\r')),
    _telemetry_source = 'sprint_1_runtime'
FROM last_provider lp
WHERE gj.id = lp.job_id;

-- Step 3: FALLBACK BACKFILL — pattern match gemini_model_used.
-- Only for jobs not covered by step 2 and that have a non-null gemini_model_used.
-- Treats 'sharp-only' / 'sharp-tint' as a special 'sharp' provider (overlay-only flow).
-- btrim() handles trailing whitespace/newlines observed in legacy data.
UPDATE generation_jobs SET
  provider_used = CASE
    WHEN btrim(gemini_model_used, E' \t\n\r') ILIKE 'gpt-image%'                       THEN 'gpt-image-2'
    WHEN btrim(gemini_model_used, E' \t\n\r') ILIKE 'sharp-%'                          THEN 'sharp'
    WHEN btrim(gemini_model_used, E' \t\n\r') = 'gemini-brand'                         THEN 'gemini-flash'
    WHEN btrim(gemini_model_used, E' \t\n\r') ILIKE '%-pro-%' OR btrim(gemini_model_used, E' \t\n\r') ILIKE '%-pro' THEN 'gemini-pro'
    WHEN btrim(gemini_model_used, E' \t\n\r') ILIKE '%-flash-%' OR btrim(gemini_model_used, E' \t\n\r') ILIKE '%-flash' THEN 'gemini-flash'
    ELSE NULL
  END,
  model_id = NULLIF(btrim(gemini_model_used, E' \t\n\r'), ''),
  _telemetry_source = 'backfill_inferred'
WHERE provider_used IS NULL
  AND gemini_model_used IS NOT NULL;

-- Step 4: REPORT post-backfill coverage. Does NOT abort — just informational.
-- This replaces the blocking ASSERT (route B is additive, so 100% coverage is not required).
DO $$
DECLARE
  total_terminal INT;
  cnt_runtime    INT;
  cnt_inferred   INT;
  cnt_null       INT;
BEGIN
  SELECT COUNT(*) INTO total_terminal
    FROM generation_jobs
    WHERE status IN ('approved', 'flagged', 'error');

  SELECT COUNT(*) INTO cnt_runtime
    FROM generation_jobs
    WHERE _telemetry_source = 'sprint_1_runtime'
      AND status IN ('approved', 'flagged', 'error');

  SELECT COUNT(*) INTO cnt_inferred
    FROM generation_jobs
    WHERE _telemetry_source = 'backfill_inferred'
      AND status IN ('approved', 'flagged', 'error');

  SELECT COUNT(*) INTO cnt_null
    FROM generation_jobs
    WHERE _telemetry_source IS NULL
      AND status IN ('approved', 'flagged', 'error');

  RAISE NOTICE '=== Migration 007 — backfill report ===';
  RAISE NOTICE '  Total terminal jobs (approved/flagged/error): %', total_terminal;
  IF total_terminal > 0 THEN
    RAISE NOTICE '  sprint_1_runtime  (high confidence):   % (% %%)',  cnt_runtime,                   ROUND(100.0 * cnt_runtime  / total_terminal, 1);
    RAISE NOTICE '  backfill_inferred (pattern-matched):   % (% %%)',  cnt_inferred,                  ROUND(100.0 * cnt_inferred / total_terminal, 1);
    RAISE NOTICE '  legacy NULL       (irrecoverable):     % (% %%)',  cnt_null,                      ROUND(100.0 * cnt_null     / total_terminal, 1);
    RAISE NOTICE '  Total covered:                         % (% %%)',  cnt_runtime + cnt_inferred,    ROUND(100.0 * (cnt_runtime + cnt_inferred) / total_terminal, 1);
  ELSE
    RAISE NOTICE '  (no terminal jobs in table — fresh schema)';
  END IF;
  RAISE NOTICE '======================================';
  RAISE NOTICE 'Note: gemini_model_used column kept for 2-3 months as audit trail.';
  RAISE NOTICE 'Filter model_performance queries by _telemetry_source to exclude inferred/legacy.';
END $$;

-- Step 5: indexes for telemetry queries
CREATE INDEX IF NOT EXISTS idx_generation_jobs_model_id           ON generation_jobs(model_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_provider_used      ON generation_jobs(provider_used);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_telemetry_source   ON generation_jobs(_telemetry_source);

-- NOTE: No DROP COLUMN gemini_model_used. Route B (additive). Schedule drop in migration 0XX
-- after >30 days of clean Sprint 1 telemetry on new jobs.

COMMIT;

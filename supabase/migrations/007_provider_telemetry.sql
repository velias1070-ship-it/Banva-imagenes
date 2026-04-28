-- Migration 007: provider telemetry columns + backfill + drop legacy gemini_model_used
--
-- Why: gemini_model_used lies when GPT-2 (or any non-Gemini provider) is used —
-- process-next:1311 and results/[jobId]:1324 hardcode it to GEMINI_MODEL_PRO/GEMINI_MODEL
-- regardless of which provider actually generated the image. The truth lives only in
-- pipeline_log JSONB (not queryable). This migration:
--   1. Adds queryable columns: provider_used, model_id, cost_usd_actual
--   2. Backfills from pipeline_log PROVIDER_USED events (shape: {event, detail, data:{cost_usd}})
--   3. Asserts >99% coverage on completed jobs (else aborts via RAISE)
--   4. Drops the lying gemini_model_used column
--
-- Order is strict and atomic in a single transaction — if assert fails, ROLLBACK.
--
-- IMPORTANT shape note: PROVIDER_USED events were logged as:
--   logPipelineEvent(job.id, 'PROVIDER_USED', smart.providerUsed, { cost_usd: smart.costEstimateUsd })
-- which the helper writes as { ts, event:'PROVIDER_USED', detail:'<provider>', data:{cost_usd} }.
-- So provider lives in event->>'detail', cost in event->'data'->>'cost_usd'. There is NO model_id
-- in pipeline_log — we infer model_id as a best-effort fallback from gemini_model_used (when the
-- provider was Gemini and the column was at least nominally correct) or 'gpt-image-2' literal.

BEGIN;

-- Step 1: ADD COLUMN
ALTER TABLE generation_jobs
  ADD COLUMN provider_used TEXT,
  ADD COLUMN model_id TEXT,
  ADD COLUMN cost_usd_actual DECIMAL(8,4);

-- Step 2: BACKFILL from pipeline_log PROVIDER_USED events
-- Take the LAST PROVIDER_USED event per job (latest attempt's truth).
WITH last_provider AS (
  SELECT DISTINCT ON (gj.id)
    gj.id AS job_id,
    ev->>'detail' AS provider_used,
    NULLIF(ev->'data'->>'cost_usd', '')::DECIMAL(8,4) AS cost_usd_actual
  FROM generation_jobs gj,
       LATERAL jsonb_array_elements(COALESCE(gj.pipeline_log, '[]'::jsonb)) AS ev
  WHERE ev->>'event' = 'PROVIDER_USED'
  ORDER BY gj.id, (ev->>'ts') DESC
)
UPDATE generation_jobs gj
SET provider_used    = lp.provider_used,
    cost_usd_actual  = lp.cost_usd_actual,
    model_id = CASE
      WHEN lp.provider_used = 'gpt-image-2' THEN 'gpt-image-2'
      WHEN lp.provider_used = 'gemini-pro'  THEN COALESCE(gj.gemini_model_used, 'gemini-3-pro-image-preview')
      WHEN lp.provider_used = 'gemini-flash' THEN COALESCE(gj.gemini_model_used, 'gemini-3.1-flash-image-preview')
      ELSE gj.gemini_model_used
    END
FROM last_provider lp
WHERE gj.id = lp.job_id;

-- Fallback for completed jobs WITHOUT a PROVIDER_USED event (legacy jobs predating the smart router):
-- if gemini_model_used is set, infer provider from it.
UPDATE generation_jobs
SET provider_used = CASE
      WHEN gemini_model_used ILIKE '%pro%' THEN 'gemini-pro'
      WHEN gemini_model_used ILIKE '%flash%' THEN 'gemini-flash'
      WHEN gemini_model_used = 'gemini-brand' THEN 'gemini-flash'
      WHEN gemini_model_used = 'sharp-only' THEN 'sharp-only'
      ELSE 'gemini-flash'
    END,
    model_id = gemini_model_used
WHERE provider_used IS NULL
  AND gemini_model_used IS NOT NULL;

-- Step 3: ASSERT coverage on completed jobs
DO $$
DECLARE
  null_count INT;
  total_completed INT;
  pct_null DECIMAL;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM generation_jobs
  WHERE provider_used IS NULL AND status IN ('completed', 'approved', 'qa_pending');

  SELECT COUNT(*) INTO total_completed
  FROM generation_jobs
  WHERE status IN ('completed', 'approved', 'qa_pending');

  IF total_completed = 0 THEN
    -- Empty table or no completed rows — accept and continue.
    RAISE NOTICE 'No completed jobs found; backfill check skipped.';
  ELSE
    pct_null := (null_count::DECIMAL / total_completed::DECIMAL) * 100;
    RAISE NOTICE 'Backfill coverage: % completed jobs, % NULL provider_used (%.2f%%).',
      total_completed, null_count, pct_null;
    IF pct_null > 1.0 THEN
      RAISE EXCEPTION
        'Backfill coverage insufficient: % of % completed jobs lack provider_used (%.2f%% > 1%% threshold). Aborting migration.',
        null_count, total_completed, pct_null;
    END IF;
  END IF;
END $$;

-- Step 4: DROP legacy column (only reached if step 3 didn't RAISE EXCEPTION)
ALTER TABLE generation_jobs DROP COLUMN gemini_model_used;

-- Step 5: index for telemetry queries
CREATE INDEX IF NOT EXISTS idx_generation_jobs_model_id ON generation_jobs(model_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_provider_used ON generation_jobs(provider_used);

COMMIT;

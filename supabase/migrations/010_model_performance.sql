-- Migration 010: model_performance materialized view + daily refresh
-- Sprint 2 issue #4.
--
-- Aggregates Sprint-1-onward runtime telemetry into per-(model, case, attempt)
-- buckets so we can spot regressions scoped to specific generation conditions
-- instead of just looking at overall provider averages. Grouping cardinality
-- is bounded by case_signature's stable token-set design (Sprint 2 issue #2).
--
-- Refresh strategy: daily at 00:00 UTC via /api/cron/refresh-model-performance
-- (CONCURRENTLY so reads aren't blocked). Routing decisions don't change hour
-- to hour — daily reduces Supabase load, manual REFRESH is one click for a
-- fresher snapshot when needed.

-- ── 1. The view itself ────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS model_performance;

CREATE MATERIALIZED VIEW model_performance AS
SELECT
  model_id,
  case_signature,
  attempt,
  COUNT(*)                                        AS total_jobs,
  COUNT(*) FILTER (WHERE status = 'approved')     AS approved_count,
  COUNT(*) FILTER (WHERE status = 'flagged')      AS flagged_count,
  COUNT(*) FILTER (WHERE status = 'error')        AS error_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'approved') / NULLIF(COUNT(*), 0),
    2
  )                                               AS approval_pct,
  ROUND(AVG(qa_score)::numeric, 4)                AS avg_qa_score,
  ROUND(AVG(cost_usd_actual)::numeric, 4)         AS avg_cost_usd,
  ROUND(SUM(cost_usd_actual)::numeric, 4)         AS total_cost_usd,
  ROUND(AVG(generation_time_ms)::numeric, 0)      AS avg_duration_ms,
  COUNT(*) FILTER (WHERE (prompt_metadata->>'cost_capped')::boolean = true)
                                                  AS cost_capped_count,
  MIN(created_at)                                 AS first_seen,
  MAX(updated_at)                                 AS last_seen
FROM generation_jobs
WHERE _telemetry_source = 'sprint_1_runtime'
  AND case_signature  IS NOT NULL
  AND model_id        IS NOT NULL
  AND status IN ('approved', 'flagged', 'error')
GROUP BY model_id, case_signature, attempt;

COMMENT ON MATERIALIZED VIEW model_performance IS
  'Sprint 2 issue #4. Aggregates per-(model, case_signature, attempt) telemetry from Sprint-1-onward jobs. Refreshed daily at 00:00 UTC by /api/cron/refresh-model-performance. Manual: REFRESH MATERIALIZED VIEW CONCURRENTLY model_performance;';

-- ── 2. Indexes ────────────────────────────────────────────────────────
-- UNIQUE index is REQUIRED by REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX idx_model_performance_pk
  ON model_performance (model_id, case_signature, attempt);

-- Common access path for the Sprint 2 issue #5 regression alert query
-- (read recent rows for a specific model + case).
CREATE INDEX idx_model_performance_last_seen
  ON model_performance (last_seen DESC);

-- ── 3. Refresh function (called by the cron via PostgREST RPC) ────────
-- SECURITY DEFINER lets the service-role-owned function run REFRESH
-- without the caller needing direct table privileges.
CREATE OR REPLACE FUNCTION refresh_model_performance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY model_performance;
END;
$$;

COMMENT ON FUNCTION refresh_model_performance() IS
  'Sprint 2 issue #4. Called by /api/cron/refresh-model-performance daily at 00:00 UTC. CONCURRENTLY required UNIQUE INDEX (idx_model_performance_pk).';

DO $$
BEGIN
  RAISE NOTICE '[010] model_performance MV + refresh function created';
END $$;

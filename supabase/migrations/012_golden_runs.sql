-- Migration 012: golden_runs table for benchmarking persistence
-- Sprint 3.
--
-- Each row = one (case × model_id_tested) execution. Sprint 3 introduces a
-- CLI (scripts/run-golden-set.ts) that drives benchmark runs against any
-- model in MODEL_REGISTRY, bypassing routing rules via forced_model_id.
-- Persisted runs are queried by scripts/compare-golden-runs.ts to produce
-- adoption recommendations.
--
-- The schema admits 3 input modes (one per row, exclusive):
--   suite_name      — Modo 1: predefined YAML suite from benchmarks/suites/
--   dynamic_filter  — Modo 2: SQL where clause against generation_jobs
--   job_ids_input   — Modo 3: explicit job-id list
--
-- compared_to_run_id stores the prior run that was diff'd against (used
-- when running compare-golden-runs.ts and persisting its conclusion as
-- a follow-up row).

CREATE TABLE IF NOT EXISTS golden_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL,                  -- groups all cases of a single CLI invocation
  suite_name           TEXT,                            -- modo 1
  dynamic_filter       TEXT,                            -- modo 2
  job_ids_input        TEXT[],                          -- modo 3
  case_id              TEXT NOT NULL,                   -- original job_id or synthetic-case slug
  model_id_tested      TEXT NOT NULL,
  score_total          NUMERIC(5,4),                    -- single composite [0..1]
  score_per_dim        JSONB,                           -- {color: 0.92, pattern: 0.88, composition: 0.95, ...}
  cost_usd             NUMERIC(8,4),
  duration_ms          INT,
  output_path          TEXT,                            -- supabase storage path of the generated image
  compared_to_run_id   UUID,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_metadata         JSONB,                           -- suite content snapshot, filter result count, error string, cli_version, etc
  CONSTRAINT golden_runs_one_input_mode CHECK (
    (suite_name IS NOT NULL)::int
    + (dynamic_filter IS NOT NULL)::int
    + (job_ids_input IS NOT NULL)::int
    >= 1
  )
);

COMMENT ON TABLE golden_runs IS
  'Sprint 3 benchmark runs. Each row = one case × model. Compared via scripts/compare-golden-runs.ts to drive adoption decisions for new models.';

COMMENT ON COLUMN golden_runs.run_id IS
  'Groups all cases of one CLI invocation. Same run_id across all rows produced by a single `npm run golden -- ...` command.';
COMMENT ON COLUMN golden_runs.case_id IS
  'For modo 2 / modo 3: original generation_jobs.id. For modo 1: synthetic case slug from the YAML suite.';
COMMENT ON COLUMN golden_runs.score_total IS
  'Composite [0..1] score (default = swatch verifier score, can be overridden via run_metadata.scoring_strategy).';
COMMENT ON COLUMN golden_runs.compared_to_run_id IS
  'When a compare-golden-runs invocation persists its diff conclusion, this links back to the baseline run_id.';

-- ── Indexes ──────────────────────────────────────────────────────────
-- Per-model history: "show me the last 50 golden runs for gemini-pro".
CREATE INDEX IF NOT EXISTS idx_golden_runs_model_run_at
  ON golden_runs (model_id_tested, run_at DESC);

-- Same case across runs: "did this case improve from one model to the next".
CREATE INDEX IF NOT EXISTS idx_golden_runs_case_id
  ON golden_runs (case_id);

-- Suite history: "show me all runs of critical-cases.yaml".
CREATE INDEX IF NOT EXISTS idx_golden_runs_suite
  ON golden_runs (suite_name)
  WHERE suite_name IS NOT NULL;

-- Run grouping: "fetch all rows for run_id X".
CREATE INDEX IF NOT EXISTS idx_golden_runs_run_id
  ON golden_runs (run_id);

DO $$
BEGIN
  RAISE NOTICE '[012] golden_runs table + 4 indexes created';
END $$;

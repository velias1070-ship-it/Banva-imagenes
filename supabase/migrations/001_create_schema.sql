-- ============================================================
-- BANVA Image Pipeline — Database Schema
-- ============================================================

-- PROJECTS
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,
  sku_base      TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- HERO SHOTS
CREATE TABLE hero_shots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  shot_type     TEXT NOT NULL DEFAULT 'lifestyle',
  display_order INT NOT NULL DEFAULT 0,
  width         INT,
  height        INT,
  file_size_kb  INT,
  mime_type     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- SWATCHES
CREATE TABLE swatches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sku_suffix    TEXT,
  color_description TEXT,
  storage_path  TEXT NOT NULL,
  dominant_color_hex TEXT,
  display_order INT NOT NULL DEFAULT 0,
  file_size_kb  INT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- GENERATION BATCHES
CREATE TABLE generation_batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending',
  total_combinations INT NOT NULL DEFAULT 0,
  completed_count    INT NOT NULL DEFAULT 0,
  approved_count     INT NOT NULL DEFAULT 0,
  retry_count        INT NOT NULL DEFAULT 0,
  flagged_count      INT NOT NULL DEFAULT 0,
  error_count        INT NOT NULL DEFAULT 0,
  inngest_run_id     TEXT,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT now(),
  estimated_cost_usd DECIMAL(10,4)
);

-- GENERATION JOBS
CREATE TABLE generation_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES generation_batches(id) ON DELETE CASCADE,
  hero_shot_id        UUID NOT NULL REFERENCES hero_shots(id),
  swatch_id           UUID NOT NULL REFERENCES swatches(id),
  status              TEXT NOT NULL DEFAULT 'pending',
  attempt             INT NOT NULL DEFAULT 1,
  prompt_text         TEXT,
  prompt_metadata     JSONB,
  output_storage_path TEXT,
  generation_time_ms  INT,
  gemini_model_used   TEXT,
  qa_score            DECIMAL(4,3),
  qa_detail           JSONB,
  qa_feedback         TEXT,
  prompt_adjustment   TEXT,
  error_message       TEXT,
  error_code          TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- CATEGORY TEMPLATES
CREATE TABLE category_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key  TEXT NOT NULL UNIQUE,
  template_data JSONB NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- INDEXES
CREATE INDEX idx_hero_shots_project ON hero_shots(project_id);
CREATE INDEX idx_swatches_project ON swatches(project_id);
CREATE INDEX idx_batches_project ON generation_batches(project_id);
CREATE INDEX idx_jobs_batch ON generation_jobs(batch_id);
CREATE INDEX idx_jobs_status ON generation_jobs(status);
CREATE INDEX idx_jobs_batch_status ON generation_jobs(batch_id, status);

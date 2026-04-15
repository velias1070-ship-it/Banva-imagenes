-- ============================================================
-- SKUs catalog + project pivot
-- ============================================================
-- Introduces the SKU as the eternal unit of the product catalog.
-- A project (tanda) becomes a work session that can touch 1 or N SKUs.
-- Images accumulate per-SKU over time, across projects.

-- SKUS
CREATE TABLE IF NOT EXISTS skus (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  product_family TEXT,
  category       TEXT,
  ml_listing_id  TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skus_product_family ON skus(product_family);
CREATE INDEX IF NOT EXISTS idx_skus_category       ON skus(category);
CREATE INDEX IF NOT EXISTS idx_skus_status         ON skus(status);

-- PROJECT ↔ SKU (N:M)
CREATE TABLE IF NOT EXISTS project_skus (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sku_id     UUID NOT NULL REFERENCES skus(id)     ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_project_skus_sku_id ON project_skus(sku_id);

-- updated_at trigger for skus
CREATE OR REPLACE FUNCTION skus_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_skus_updated_at ON skus;
CREATE TRIGGER trg_skus_updated_at
  BEFORE UPDATE ON skus
  FOR EACH ROW
  EXECUTE FUNCTION skus_set_updated_at();

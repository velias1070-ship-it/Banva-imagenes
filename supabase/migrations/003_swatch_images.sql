-- Multiple reference images per swatch
CREATE TABLE IF NOT EXISTS swatch_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swatch_id UUID NOT NULL REFERENCES swatches(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  label TEXT DEFAULT '',
  file_size_kb INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_swatch_images_swatch ON swatch_images(swatch_id);

-- Enable RLS with permissive policies (same pattern as other tables)
ALTER TABLE swatch_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "swatch_images_select" ON swatch_images FOR SELECT USING (true);
CREATE POLICY "swatch_images_insert" ON swatch_images FOR INSERT WITH CHECK (true);
CREATE POLICY "swatch_images_update" ON swatch_images FOR UPDATE USING (true);
CREATE POLICY "swatch_images_delete" ON swatch_images FOR DELETE USING (true);

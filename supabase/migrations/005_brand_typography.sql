-- Add per-role typography fields to brands table
ALTER TABLE brands ADD COLUMN IF NOT EXISTS typography_title TEXT DEFAULT '';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS typography_subtitle TEXT DEFAULT '';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS typography_subsubtitle TEXT DEFAULT '';
-- Keep the old 'typography' column for backward compatibility (it becomes a fallback)

-- Brand books: visual identity per brand (logo, colors, typography, guidelines)
CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                          -- e.g. "American Family", "Cannon"
  slug TEXT NOT NULL UNIQUE,
  logo_storage_path TEXT DEFAULT '',           -- PNG with transparent background
  logo_position TEXT DEFAULT 'top-left',       -- top-left, top-right, bottom-left, bottom-right
  logo_margin_px INT DEFAULT 40,
  logo_size_px INT DEFAULT 150,                -- max width/height of logo overlay
  primary_color TEXT DEFAULT '#000000',        -- hex for headers/titles
  secondary_color TEXT DEFAULT '#666666',      -- hex for body text
  accent_color TEXT DEFAULT '#7CB9D6',         -- hex for highlights
  typography TEXT DEFAULT '',                  -- description for AI prompt (e.g. "Sans-serif bold, clean modern style")
  prompt_guidelines TEXT DEFAULT '',           -- extra instructions injected into generation prompts
  apply_logo_overlay BOOLEAN DEFAULT true,     -- whether to overlay logo on generated images
  apply_to_shot_types TEXT[] DEFAULT '{}',     -- empty = all shots, or specific: {'main','lifestyle','packaging'}
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Link projects to brands
ALTER TABLE projects ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

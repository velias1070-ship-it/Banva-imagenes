-- Migration 015: tag heroes with design + size applicability.
-- Limpiapies (y futuras categorias multi-tamano) reusan el mismo diseno
-- en varios tamanos. Queremos mapear cada hero al subset de variantes que
-- tiene sentido cubrir, sin duplicar archivos por SKU.

ALTER TABLE hero_shots
  ADD COLUMN IF NOT EXISTS applies_to_designs text[],
  ADD COLUMN IF NOT EXISTS applies_to_sizes   text[];

COMMENT ON COLUMN hero_shots.applies_to_designs IS
  'Lista de design slugs (e.g. ["katze","leaves"]). NULL = aplica a todos los disenos del proyecto.';
COMMENT ON COLUMN hero_shots.applies_to_sizes IS
  'Lista de size slugs canonicos (e.g. ["40x60","60x120"]). NULL = aplica a todos los tamanos.';

CREATE INDEX IF NOT EXISTS hero_shots_applies_designs_gin
  ON hero_shots USING gin (applies_to_designs);
CREATE INDEX IF NOT EXISTS hero_shots_applies_sizes_gin
  ON hero_shots USING gin (applies_to_sizes);

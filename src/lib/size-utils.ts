// ─────────────────────────────────────────────────────────────────────────────
// Size Utils — Extract bed size from SKU and build size-aware prompt notes
// ─────────────────────────────────────────────────────────────────────────────
// Only applies to bed-related categories (sabanas, quilts, cubrecamas, etc.)
// Non-bed categories return null — no size adjustment needed.
// ─────────────────────────────────────────────────────────────────────────────

export interface SizeInfo {
  code: string;       // "P10", "P15", "P20", "P25", "P30"
  plazas: number;     // 1, 1.5, 2, 2.5, 3
  label: string;      // "1 Plaza", "1.5 Plazas", "2 Plazas"
  pillowcases: number; // 1 for 1P/1.5P, 2 for 2P+
}

const BED_CATEGORIES = new Set([
  'sabanas', 'quilts', 'cubrecamas', 'plumones', 'frazadas', 'toppers', 'cubre-colchon',
]);

/**
 * Extract size info from a SKU suffix.
 * Returns null if the SKU doesn't contain a recognizable size code.
 */
export function extractSizeFromSku(sku: string | null | undefined): SizeInfo | null {
  if (!sku) return null;

  // Pattern 1: "P10", "P15", "P20", "P25", "P30"
  const pMatch = sku.match(/P(10|15|20|25|30)/);
  if (pMatch) {
    const num = parseInt(pMatch[1], 10);
    const plazas = num / 10;
    return {
      code: `P${pMatch[1]}`,
      plazas,
      label: plazas === 1 ? '1 Plaza' : `${plazas} Plazas`,
      pillowcases: plazas >= 2 ? 2 : 1,
    };
  }

  // Pattern 2: bare "15", "20", "25", "30" surrounded by letters
  for (const num of ['30', '25', '20', '15', '10']) {
    const idx = sku.indexOf(num);
    if (idx >= 0) {
      const before = idx > 0 ? sku[idx - 1] : '';
      const after = idx + 2 < sku.length ? sku[idx + 2] : '';
      if ((/[A-Za-z]/.test(before) || idx === 0) && (/[A-Za-z]/.test(after) || after === '')) {
        const plazas = parseInt(num, 10) / 10;
        return {
          code: num,
          plazas,
          label: plazas === 1 ? '1 Plaza' : `${plazas} Plazas`,
          pillowcases: plazas >= 2 ? 2 : 1,
        };
      }
    }
  }

  return null;
}

/**
 * Build a size-aware prompt note to append after the main prompt.
 * Returns empty string if:
 * - Category is not a bed product
 * - SKU has no size info
 * - Size is 2+ plazas (no adjustment needed — 2P is the default hero size)
 */
export function buildSizePromptNote(
  sku: string | null | undefined,
  category: string
): string {
  if (!BED_CATEGORIES.has(category)) return '';

  const size = extractSizeFromSku(sku);
  if (!size) return '';

  // 2+ plazas = default, no adjustment needed
  if (size.plazas >= 2) return '';

  const isOneP = size.plazas === 1;
  const sizeLabel = size.label;

  return `

AJUSTE DE TAMAÑO — ESTE PRODUCTO ES DE ${sizeLabel.toUpperCase()}:
La imagen generada debe reflejar un producto de ${sizeLabel}, NO de 2 plazas ni Queen.

CAMBIOS OBLIGATORIOS:
- Si hay texto que dice "Queen", "2 Plazas", "Full", o cualquier referencia a tamaño mayor → CAMBIAR a "${sizeLabel}"
- Si hay texto que dice "2 Pillow Cases" o "2 Fundas de Almohada" → CAMBIAR a "1 Funda de Almohada"
- Si hay texto en ingles sobre cantidades → traducir a español y ajustar a ${sizeLabel}
- Si la imagen muestra VISUALMENTE 2 almohadas o 2 fundas → mostrar solo 1
- Si la imagen muestra una cama → debe ser una cama ${isOneP ? 'individual (1 plaza)' : 'de 1.5 plazas (twin)'} con 1 almohada centrada
- El producto textil debe verse proporcionalmente mas pequeño (acorde a ${sizeLabel})
- Si hay piezas dobladas/apiladas y se ven 2 fundas separadas → mostrar solo 1

MANTENER: mismo diseño, color, patron, textura, estilo fotografico, fondo, y composicion general.
Solo ajustar lo relacionado al TAMAÑO del set.`;
}

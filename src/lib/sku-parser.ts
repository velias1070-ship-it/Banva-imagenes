// Parsea SKUs de proyectos multi-tamano (limpiapies, alfombras, etc.)
// para extraer el tamano canonico. El "diseno" se toma del color_slug que
// ya viene en project.metadata.variantes — no se re-deriva del SKU.

const SIZE_PATTERNS: Array<{ regex: RegExp; size: string }> = [
  { regex: /4060$/, size: '40x60' },
  { regex: /4575$/, size: '45x75' },
  { regex: /6012$/, size: '60x120' },
  { regex: /80120$/, size: '80x120' },
  { regex: /5790$/, size: '57x90' },
];

export function extractSizeFromSku(sku: string): string | null {
  if (!sku) return null;
  const upper = sku.toUpperCase();
  for (const { regex, size } of SIZE_PATTERNS) {
    if (regex.test(upper)) return size;
  }
  return null;
}

export interface ProjectVariant {
  sku: string;
  color: string;
  color_slug: string;
  source: 'catalogo' | 'ml';
}

export interface ResolvedVariant extends ProjectVariant {
  design: string; // == color_slug
  size: string | null;
}

export function resolveVariants(variantes: ProjectVariant[]): ResolvedVariant[] {
  return variantes.map((v) => ({
    ...v,
    design: v.color_slug,
    size: extractSizeFromSku(v.sku),
  }));
}

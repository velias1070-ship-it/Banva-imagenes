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

export interface TaggedHero {
  id: string;
  display_order: number;
  applies_to_designs: string[] | null;
  applies_to_sizes: string[] | null;
}

export type ResolverTier = 'exact' | 'design_only' | 'size_only' | 'generic' | 'none';

const TIER_RANK: Record<ResolverTier, number> = {
  exact: 0,
  design_only: 1,
  size_only: 2,
  generic: 3,
  none: 4,
};

function classifyHero(hero: TaggedHero, design: string | null, size: string | null): ResolverTier {
  const dList = hero.applies_to_designs;
  const sList = hero.applies_to_sizes;

  // Hero excludes this design or size explicitly.
  if (design && dList && !dList.includes(design)) return 'none';
  if (size && sList && !sList.includes(size)) return 'none';

  const dSpecific = !!dList && dList.length > 0;
  const sSpecific = !!sList && sList.length > 0;

  if (dSpecific && sSpecific) return 'exact';
  if (dSpecific) return 'design_only';
  if (sSpecific) return 'size_only';
  return 'generic';
}

export interface ResolvedHero<H extends TaggedHero> {
  hero: H;
  tier: ResolverTier;
}

export function resolveHeroForVariant<H extends TaggedHero>(
  heroes: H[],
  design: string | null,
  size: string | null
): ResolvedHero<H> | null {
  const ranked = heroes
    .map((h) => ({ hero: h, tier: classifyHero(h, design, size) }))
    .filter((r) => r.tier !== 'none')
    .sort((a, b) => {
      const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (t !== 0) return t;
      return a.hero.display_order - b.hero.display_order;
    });
  return ranked[0] || null;
}

export function anyHeroHasTags(heroes: TaggedHero[]): boolean {
  return heroes.some(
    (h) =>
      (Array.isArray(h.applies_to_designs) && h.applies_to_designs.length > 0) ||
      (Array.isArray(h.applies_to_sizes) && h.applies_to_sizes.length > 0)
  );
}

import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { resolveVariants, type ProjectVariant } from '@/lib/sku-parser';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface HeroRow {
  id: string;
  filename: string;
  storage_path: string;
  shot_type: string | null;
  display_order: number;
  applies_to_designs: string[] | null;
  applies_to_sizes: string[] | null;
}

type MatchTier = 'exact' | 'design_only' | 'size_only' | 'generic';

interface CellSummary {
  design: string;
  size: string;
  exact: number;
  design_only: number;
  size_only: number;
  generic: number;
  status: 'green' | 'yellow' | 'red';
}

function classify(hero: HeroRow, design: string, size: string): MatchTier {
  const dMatch = !hero.applies_to_designs || hero.applies_to_designs.includes(design);
  const sMatch = !hero.applies_to_sizes || hero.applies_to_sizes.includes(size);
  const dSpecific = !!hero.applies_to_designs && hero.applies_to_designs.includes(design);
  const sSpecific = !!hero.applies_to_sizes && hero.applies_to_sizes.includes(size);

  if (!dMatch || !sMatch) return 'generic'; // no aplica, lo descartamos abajo

  if (dSpecific && sSpecific) return 'exact';
  if (dSpecific) return 'design_only';
  if (sSpecific) return 'size_only';
  return 'generic';
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = await createServerSupabase();

  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, name, sku_base, category, metadata')
    .eq('id', id)
    .single();

  if (projErr || !project) {
    return NextResponse.json({ error: projErr?.message || 'project not found' }, { status: 404 });
  }

  const variantes = ((project.metadata as { variantes?: ProjectVariant[] } | null)?.variantes) || [];
  const resolved = resolveVariants(variantes);

  // Tras la migracion 015 estas columnas existen. Si la migracion aun no fue
  // aplicada, el cliente devuelve "column does not exist" y caemos al
  // fallback que las trata como NULL.
  const heroSelect = 'id, filename, storage_path, shot_type, display_order, applies_to_designs, applies_to_sizes';
  let heroes: HeroRow[] = [];
  const { data: heroData, error: heroErr } = await supabase
    .from('hero_shots')
    .select(heroSelect)
    .eq('project_id', id)
    .order('display_order', { ascending: true });

  if (heroErr) {
    // Fallback: columnas nuevas no existen aun -> tratar todo como generico.
    const { data: legacy } = await supabase
      .from('hero_shots')
      .select('id, filename, storage_path, shot_type, display_order')
      .eq('project_id', id)
      .order('display_order', { ascending: true });
    heroes = (legacy || []).map((h) => ({
      ...h,
      applies_to_designs: null,
      applies_to_sizes: null,
    })) as HeroRow[];
  } else {
    heroes = heroData as HeroRow[];
  }

  // Ejes de la grilla
  const designSet = new Map<string, string>(); // slug -> color name
  const sizeSet = new Set<string>();
  for (const v of resolved) {
    if (!designSet.has(v.design)) designSet.set(v.design, v.color);
    if (v.size) sizeSet.add(v.size);
  }
  const designs = Array.from(designSet.entries()).map(([slug, name]) => ({ slug, name }));
  const sizes = Array.from(sizeSet).sort();

  // Matriz
  const cells: CellSummary[] = [];
  for (const d of designs) {
    for (const s of sizes) {
      const counts = { exact: 0, design_only: 0, size_only: 0, generic: 0 };
      for (const h of heroes) {
        // Filtrar heros que NO aplican a esta celda
        const dMatch = !h.applies_to_designs || h.applies_to_designs.includes(d.slug);
        const sMatch = !h.applies_to_sizes || h.applies_to_sizes.includes(s);
        if (!dMatch || !sMatch) continue;
        const tier = classify(h, d.slug, s);
        counts[tier]++;
      }
      const status: CellSummary['status'] =
        counts.exact > 0
          ? 'green'
          : counts.design_only + counts.size_only > 0
            ? 'yellow'
            : counts.generic > 0
              ? 'yellow'
              : 'red';
      cells.push({ design: d.slug, size: s, ...counts, status });
    }
  }

  return NextResponse.json({
    project: { id: project.id, name: project.name, sku_base: project.sku_base, category: project.category },
    designs,
    sizes,
    heroes_total: heroes.length,
    variants_total: resolved.length,
    variants_with_size: resolved.filter((v) => v.size).length,
    variants_without_size: resolved.filter((v) => !v.size).map((v) => v.sku),
    cells,
  });
}

/**
 * One-shot backfill: agrega los swatches King existentes a
 * project.metadata.variantes y enriquece TODAS las variantes con
 * bed_size + color + tipo + label desde ml_items_map.
 *
 * Pensado para corregir proyectos creados antes del fix de from-sku
 * donde swatches King no aparecian en el filtro de tamaño.
 *
 * Run: npx tsx --env-file=.env.local scripts/backfill-king-variants.ts
 */

import { createClient } from '@supabase/supabase-js';

const banvaApp = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const inventory = createClient(
  process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PATTERN_TYPES = new Set([
  'estampado', 'estampados', 'liso', 'lisos',
  'estampada', 'estampadas', 'lisa', 'lisas',
  'bordado', 'bordados', 'jacquard',
]);
function slugify(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/(^-|-$)/g, '');
}
function parseVariantLabel(title: string, familyName: string | null): { color: string; tipo: string | null } {
  if (!title) return { color: '', tipo: null };
  let tail = title.trim();
  if (familyName && tail.toLowerCase().startsWith(familyName.toLowerCase())) {
    tail = tail.slice(familyName.length).trim();
  }
  const words = tail.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { color: '', tipo: null };
  const last = words[words.length - 1];
  const isType = PATTERN_TYPES.has(last.toLowerCase());
  if (isType && words.length >= 2) return { color: words[words.length - 2], tipo: last };
  return { color: last, tipo: null };
}

interface ExistingVariant {
  sku: string;
  [k: string]: unknown;
}

async function main() {
  // 1. Find all swatches with P25-* suffix (King)
  const { data: kingSwatches } = await banvaApp
    .from('swatches')
    .select('id, sku_suffix, project_id, name')
    .not('sku_suffix', 'is', null)
    .like('sku_suffix', '%P25_');
  if (!kingSwatches?.length) {
    console.log('No P25 swatches found');
    return;
  }

  const projectIds = [...new Set(kingSwatches.map((s) => s.project_id))];
  console.log(`Found ${kingSwatches.length} King swatches across ${projectIds.length} projects`);

  for (const projectId of projectIds) {
    const { data: proj } = await banvaApp
      .from('projects')
      .select('id, name, metadata')
      .eq('id', projectId)
      .single();
    if (!proj) continue;

    const meta = (proj.metadata || {}) as { variantes?: ExistingVariant[] };
    const variantes: ExistingVariant[] = Array.isArray(meta.variantes) ? meta.variantes : [];
    const existingSkus = new Set(variantes.map((v) => (v.sku || '').toUpperCase()));

    // Add missing King swatches with minimal shape
    const projSwatches = kingSwatches.filter((s) => s.project_id === projectId);
    let addedCount = 0;
    for (const sw of projSwatches) {
      if (!existingSkus.has(sw.sku_suffix!.toUpperCase())) {
        variantes.push({
          sku: sw.sku_suffix!,
          color: sw.name || sw.sku_suffix!,
          color_slug: slugify(sw.name || sw.sku_suffix!),
          source: 'catalogo',
        });
        addedCount++;
      }
    }

    // Now enrich ALL variantes with ml_items_map data
    const skus = variantes.map((v) => v.sku).filter(Boolean);
    const [bySku, bySkuVenta] = await Promise.all([
      inventory.from('ml_items_map')
        .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
        .eq('activo', true).is('variation_id', null).in('sku', skus),
      inventory.from('ml_items_map')
        .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
        .eq('activo', true).is('variation_id', null).in('sku_venta', skus),
    ]);
    type MlRow = NonNullable<typeof bySku.data>[number];
    const lookup = new Map<string, MlRow>();
    for (const row of bySku.data || []) if (row.sku) lookup.set(row.sku, row);
    for (const row of bySkuVenta.data || []) if (row.sku_venta) lookup.set(row.sku_venta, row);

    let enriched = 0;
    const newVariantes = variantes.map((v) => {
      const ml = lookup.get(v.sku);
      if (!ml) return v;
      enriched++;
      const titulo = ml.titulo || '';
      const familyName = ml.family_name || null;
      const parsed = parseVariantLabel(titulo, familyName);
      const color = parsed.color || (v.color as string) || v.sku;
      const tipo = parsed.tipo || null;
      const bedSize = ml.bed_size || null;
      const labelParts = [color, tipo, bedSize].filter(Boolean);
      return {
        ...v,
        color,
        color_slug: slugify(`${color}-${tipo || ''}`) || slugify(color),
        source: 'catalogo' as const,
        tipo,
        bed_size: bedSize,
        label: labelParts.join(' · '),
        item_id: ml.item_id,
        titulo,
        thumbnail: ml.thumbnail || undefined,
        permalink: ml.permalink || undefined,
      };
    });

    const newMeta = { ...meta, variantes: newVariantes };
    const { error } = await banvaApp
      .from('projects')
      .update({ metadata: newMeta })
      .eq('id', projectId);
    if (error) {
      console.error(`  ${proj.name}: UPDATE failed: ${error.message}`);
      continue;
    }
    console.log(`  ${proj.name}:`);
    console.log(`    + added ${addedCount} new variantes`);
    console.log(`    + enriched ${enriched}/${variantes.length} from ml_items_map`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PATTERN_TYPES = new Set([
  'estampado', 'estampados', 'liso', 'lisos',
  'estampada', 'estampadas', 'lisa', 'lisas',
  'bordado', 'bordados', 'jacquard',
]);

function slugify(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '');
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

// POST /api/projects/[id]/backfill-variantes
//
// Reconstruye project.metadata.variantes desde ml_items_map para proyectos
// creados antes del refactor de family_name + tipo + bed_size. Mantiene los
// SKUs existentes pero les pone los labels descriptivos nuevos.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const projectsDb = createAdminClient();

  const { data: project, error: projErr } = await projectsDb
    .from('projects')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (projErr || !project) {
    return NextResponse.json({ error: projErr?.message || 'project not found' }, { status: 404 });
  }

  const metadata = (project.metadata as { variantes?: Array<{ sku: string; color?: string; color_slug?: string; source?: string }> } | null) || {};
  const variantes = Array.isArray(metadata.variantes) ? metadata.variantes : [];
  if (variantes.length === 0) {
    return NextResponse.json({ ok: true, message: 'no variantes to backfill', updated: 0 });
  }

  const skus = variantes.map((v) => v.sku).filter(Boolean);
  if (skus.length === 0) {
    return NextResponse.json({ ok: true, message: 'no SKUs', updated: 0 });
  }

  const inventoryUrl = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const inventoryKey = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const inventoryDb = createClient(inventoryUrl, inventoryKey);

  // Buscar por sku Y por sku_venta (uno de los dos puede tener match)
  const [bySku, bySkuVenta] = await Promise.all([
    inventoryDb
      .from('ml_items_map')
      .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
      .eq('activo', true)
      .is('variation_id', null)
      .in('sku', skus),
    inventoryDb
      .from('ml_items_map')
      .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
      .eq('activo', true)
      .is('variation_id', null)
      .in('sku_venta', skus),
  ]);

  const lookup = new Map<string, NonNullable<typeof bySku.data>[number]>();
  for (const row of bySku.data || []) if (row.sku) lookup.set(row.sku, row);
  for (const row of bySkuVenta.data || []) if (row.sku_venta) lookup.set(row.sku_venta, row);

  let matched = 0;
  const newVariantes = variantes.map((v) => {
    const ml = lookup.get(v.sku);
    if (!ml) return v; // dejar tal cual
    matched++;
    const titulo = ml.titulo || '';
    const familyName = ml.family_name || null;
    const parsed = parseVariantLabel(titulo, familyName);
    const color = parsed.color || v.color || v.sku;
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

  const newMetadata = { ...metadata, variantes: newVariantes };
  const { error: updErr } = await projectsDb
    .from('projects')
    .update({ metadata: newMetadata })
    .eq('id', id);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    total: variantes.length,
    matched,
    unchanged: variantes.length - matched,
  });
}

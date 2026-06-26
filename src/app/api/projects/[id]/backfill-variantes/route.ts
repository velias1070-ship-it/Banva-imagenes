import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveItemIdForSku } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PATTERN_TYPES = new Set([
  'estampado', 'estampados', 'liso', 'lisos',
  'estampada', 'estampadas', 'lisa', 'lisas',
  'bordado', 'bordados', 'jacquard',
]);

// Stopwords for the "smart" design extraction. Anything in this list cannot
// be the design name. Includes generic Cannon/sabana noise.
const TITLE_STOPWORDS = new Set([
  'cm', 'm',
  'plazas', 'plaza', 'king', 'super',
  'de', 'y', 'en', 'la', 'el', 'con', 'para', 'del', 'a',
  'sabanas', 'sabana', 'sábanas', 'sábana',
  'cannon', 'cannonhome',
  'hilos', 'hilo',
  'algodon', 'algodón', 'poliester', 'poliéster',
  'media', 'full', 'twin', 'queen',
  'set', 'juego', 'pack',
  'mercadolibre', 'envio', 'envío',
  'polar', 'fleece',
]);
function normalizeWord(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Pick the first non-stopword non-numeric token whose normalised form is unique
// in the title. This handles "Sabanas King ... Algodon Hibiscus 200 Hilos" → "Hibiscus".
function smartDesignFromTitle(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of words) {
    const n = normalizeWord(w);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  for (const w of words) {
    const n = normalizeWord(w);
    if (TITLE_STOPWORDS.has(n)) continue;
    if (/^\d+([.,]\d+)?$/.test(w)) continue;
    if (w.length <= 1) continue;
    if (counts.get(n) === 1) return w;
  }
  return null;
}

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
  // If the last word is a stopword (e.g. titles ending in "200 Hilos"), fall
  // back to the smart extractor so we get "Hibiscus" instead of "Hilos".
  if (TITLE_STOPWORDS.has(normalizeWord(last))) {
    const smart = smartDesignFromTitle(title);
    if (smart) return { color: smart, tipo: null };
  }
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

  // Resolver determinista del item_id por SKU (fuente compartida con el resto de la app)
  const itemIdBySku = new Map<string, string>();
  await Promise.all(
    skus.map(async (sku) => {
      const r = await resolveItemIdForSku(sku);
      if (r.item_id) itemIdBySku.set(sku, r.item_id);
    }),
  );

  // Enriquecer con metadata de ml_items_map a partir del item_id ya resuelto
  const itemIds = Array.from(new Set(itemIdBySku.values()));
  const byItemId = await inventoryDb
    .from('ml_items_map')
    .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
    .eq('activo', true)
    .is('variation_id', null)
    .in('item_id', itemIds);

  const lookup = new Map<string, NonNullable<typeof byItemId.data>[number]>();
  for (const row of byItemId.data || []) if (row.item_id) lookup.set(row.item_id, row);

  let matched = 0;
  const newVariantes = variantes.map((v) => {
    const itemId = itemIdBySku.get(v.sku);
    const ml = itemId ? lookup.get(itemId) : undefined;
    if (!ml) return v; // dejar tal cual (no encontrado)
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

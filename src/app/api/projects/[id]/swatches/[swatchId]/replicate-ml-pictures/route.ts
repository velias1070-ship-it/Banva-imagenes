import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet, mlPut } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

type Mode = 'replace' | 'prepend' | 'append';

interface MlPicture {
  id: string;
}

interface TargetResult {
  swatch_id: string;
  sku: string;
  item_id: string;
  status: 'success' | 'skipped' | 'error';
  pictures_total: number;
  error?: string;
}

// POST /api/projects/[id]/swatches/[swatchId]/replicate-ml-pictures
//
// Replicates the source SKU's currently-published ML pictures to the
// destination swatches' ML listings. Pure ML→ML — no generation_jobs are
// created. Picture IDs are seller-scoped, so they can be reused across items
// belonging to the same ML seller without re-uploading binaries.
//
// Body:
//   { target_swatch_ids: string[],
//     picture_ids: string[],          // ordered, source ML picture IDs to push
//     mode?: 'replace' | 'prepend' | 'append',  // default 'replace'
//     max_pictures?: number }         // default 10 (ML cap varies)
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId: sourceSwatchId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const targetIds: string[] = Array.isArray(body.target_swatch_ids)
    ? body.target_swatch_ids.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const pictureIds: string[] = Array.isArray(body.picture_ids)
    ? body.picture_ids.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const mode: Mode =
    body.mode === 'prepend' || body.mode === 'append' || body.mode === 'replace' ? body.mode : 'replace';
  const maxPictures: number = typeof body.max_pictures === 'number' && body.max_pictures > 0 ? body.max_pictures : 10;

  if (targetIds.length === 0) {
    return NextResponse.json({ error: 'target_swatch_ids requerido' }, { status: 400 });
  }
  if (pictureIds.length === 0) {
    return NextResponse.json({ error: 'picture_ids requerido' }, { status: 400 });
  }
  if (targetIds.includes(sourceSwatchId)) {
    return NextResponse.json({ error: 'no podes replicar al mismo swatch' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // Resolve each target swatch → its ML item_id via ml_items_map.
  const { data: targets, error: tgtErr } = await supabase
    .from('swatches')
    .select('id, sku_suffix')
    .in('id', targetIds)
    .eq('project_id', projectId);
  if (tgtErr) return NextResponse.json({ error: tgtErr.message }, { status: 500 });
  if (!targets?.length) return NextResponse.json({ error: 'targets no encontrados' }, { status: 404 });

  const targetSkus = targets.map((t) => t.sku_suffix).filter(Boolean) as string[];
  const { data: mlMappings } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id')
    .in('sku_venta', targetSkus)
    .eq('activo', true)
    .is('variation_id', null);
  const skuToItem = new Map((mlMappings || []).map((m) => [m.sku_venta, m.item_id]));

  // Pre-build the new entries — same picture IDs reused across targets.
  const newEntries = pictureIds.map((id) => ({ id }));

  const results: TargetResult[] = [];
  for (const target of targets) {
    const sku = target.sku_suffix || '';
    if (!sku) {
      results.push({ swatch_id: target.id, sku: '', item_id: '', status: 'skipped', pictures_total: 0, error: 'sin sku_suffix' });
      continue;
    }
    const itemId = skuToItem.get(sku);
    if (!itemId) {
      results.push({ swatch_id: target.id, sku, item_id: '', status: 'skipped', pictures_total: 0, error: 'sin publicación ML activa' });
      continue;
    }
    try {
      let merged: { id: string }[];
      if (mode === 'replace') {
        merged = newEntries.slice(0, maxPictures);
      } else {
        const itemData = await mlGet<{ pictures?: MlPicture[] }>(`/items/${itemId}?attributes=pictures`);
        const existing = (itemData.pictures || []).map((p) => ({ id: p.id }));
        if (mode === 'prepend') {
          // Skip existing entries that duplicate one of the new IDs (otherwise
          // ML keeps both copies and the order gets weird).
          const newIds = new Set(newEntries.map((e) => e.id));
          const dedupedExisting = existing.filter((e) => !newIds.has(e.id));
          merged = [...newEntries, ...dedupedExisting].slice(0, maxPictures);
        } else {
          // append
          const existingIds = new Set(existing.map((e) => e.id));
          const dedupedNew = newEntries.filter((e) => !existingIds.has(e.id));
          merged = [...existing, ...dedupedNew].slice(0, maxPictures);
        }
      }
      await mlPut(`/items/${itemId}`, { pictures: merged });
      results.push({ swatch_id: target.id, sku, item_id: itemId, status: 'success', pictures_total: merged.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ swatch_id: target.id, sku, item_id: itemId, status: 'error', pictures_total: 0, error: message });
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    picture_count: pictureIds.length,
    targets: targets.length,
    success: results.filter((r) => r.status === 'success').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    details: results,
  });
}

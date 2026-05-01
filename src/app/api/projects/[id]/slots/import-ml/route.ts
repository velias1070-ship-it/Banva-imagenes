import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MlPicture {
  id: string;
  url?: string;
  secure_url?: string;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

// POST /api/projects/[id]/slots/import-ml
//
// Para cada swatch del proyecto que tenga publicacion ML activa, lee las
// fotos actuales y las guarda en swatch_ml_pictures (cache). Esto alimenta
// la grilla pivot para mostrar 🔵 (solo ML) y 🟡 (drift) por celda.
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  const { data: swatches, error: swErr } = await supabase
    .from('swatches')
    .select('id, sku_suffix')
    .eq('project_id', projectId);
  if (swErr) return NextResponse.json({ error: swErr.message }, { status: 500 });
  if (!swatches?.length) return NextResponse.json({ ok: true, synced: 0 });

  const skus = swatches.map((s) => s.sku_suffix).filter(Boolean) as string[];
  const { data: mlMap } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, sku, item_id')
    .or(`sku_venta.in.(${skus.join(',')}),sku.in.(${skus.join(',')})`)
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItemId = new Map<string, string>();
  for (const m of mlMap || []) {
    if (m.sku_venta) skuToItemId.set(m.sku_venta, m.item_id);
    if (m.sku) skuToItemId.set(m.sku, m.item_id);
  }

  let imported = 0;
  let withMl = 0;
  const errors: string[] = [];

  for (const swatch of swatches) {
    const sku = swatch.sku_suffix;
    if (!sku) continue;
    const itemId = skuToItemId.get(sku);
    if (!itemId) continue;
    withMl++;

    try {
      const item = await mlGet<{ pictures?: MlPicture[] }>(
        `/items/${itemId}?attributes=pictures`
      );
      const pics = item.pictures || [];

      // Reemplazar el cache para este swatch
      await supabase.from('swatch_ml_pictures').delete().eq('swatch_id', swatch.id);
      if (pics.length > 0) {
        const rows = pics.map((p, idx) => ({
          swatch_id: swatch.id,
          position: idx + 1,
          ml_picture_id: p.id,
          ml_picture_url: p.secure_url || p.url || '',
          fetched_at: new Date().toISOString(),
        }));
        const { error: insErr } = await supabase.from('swatch_ml_pictures').insert(rows);
        if (insErr) errors.push(`${sku}: ${insErr.message}`);
        else imported += rows.length;
      }
    } catch (err) {
      errors.push(`${sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    ok: true,
    swatches_total: swatches.length,
    swatches_with_ml: withMl,
    pictures_imported: imported,
    errors: errors.slice(0, 20),
    error_count: errors.length,
  });
}

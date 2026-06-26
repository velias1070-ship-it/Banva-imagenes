import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet, resolveItemIdForSku } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MlPicture {
  id: string;
  url?: string;
  secure_url?: string;
}

// POST /api/projects/[id]/slots/import-ml
//
// Para cada swatch del proyecto que tenga publicacion ML activa, lee las
// fotos actuales y las guarda en swatch_ml_pictures (cache). Esto alimenta
// la grilla pivot para mostrar 🔵 (solo ML) y 🟡 (drift) por celda.
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const supabase = createAdminClient();

  const { data: swatches, error: swErr } = await supabase
    .from('swatches')
    .select('id, sku_suffix')
    .eq('project_id', projectId);
  if (swErr) return NextResponse.json({ error: swErr.message }, { status: 500 });
  if (!swatches?.length) return NextResponse.json({ ok: true, synced: 0 });

  let imported = 0;
  let withMl = 0;
  const errors: string[] = [];

  for (const swatch of swatches) {
    const sku = swatch.sku_suffix;
    if (!sku) continue;
    const r = await resolveItemIdForSku(sku);
    const itemId = r.item_id;
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

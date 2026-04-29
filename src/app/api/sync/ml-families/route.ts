import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface MlAttribute {
  id?: string;
  name?: string;
  value_name?: string | null;
}

interface MlItem {
  id: string;
  title?: string;
  family_name?: string | null;
  thumbnail?: string | null;
  permalink?: string | null;
  price?: number | null;
  user_product_id?: string | null;
  attributes?: MlAttribute[];
}

const SIZE_ATTR_IDS = new Set([
  'BED_SIZE',
  'PACK_SIZE',
  'SIZE',
  'MATTRESS_SIZE',
  'PILLOW_SIZE',
  'TOWEL_SIZE',
  'RUG_SIZE',
]);

function extractBedSize(attrs?: MlAttribute[]): string | null {
  if (!attrs?.length) return null;
  for (const a of attrs) {
    if (a.id && SIZE_ATTR_IDS.has(a.id) && a.value_name) return a.value_name;
  }
  // Fallback: any attribute whose name mentions "tamaño" or "plaza"
  for (const a of attrs) {
    if (!a.value_name) continue;
    const n = (a.name || '').toLowerCase();
    if (n.includes('tamaño') || n.includes('plaza') || n.includes('medida')) {
      return a.value_name;
    }
  }
  return null;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// POST /api/sync/ml-families
//   ?limit=N       — only sync first N items (default: all active)
//   ?stale_only=1  — only refresh rows where family_name IS NULL
//
// Calls ML multiget /items?ids=...&attributes=id,title,family_name,thumbnail,permalink,price,user_product_id
// in batches of 20, then upserts back to ml_items_map.
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '0', 10) || null;
  const staleOnly = url.searchParams.get('stale_only') === '1';

  const supabase = getInventorySupabase();

  let query = supabase
    .from('ml_items_map')
    .select('item_id')
    .eq('activo', true)
    .is('variation_id', null);

  if (staleOnly) query = query.is('family_name', null);
  if (limit) query = query.limit(limit);

  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const itemIds = Array.from(new Set((rows || []).map((r) => r.item_id).filter(Boolean)));
  if (itemIds.length === 0) {
    return NextResponse.json({ ok: true, synced: 0, message: 'No items to sync' });
  }

  let synced = 0;
  const errors: string[] = [];
  const batches = chunk(itemIds, 20);

  for (const batch of batches) {
    const ids = batch.join(',');
    const path = `/items?ids=${ids}&attributes=id,title,family_name,thumbnail,permalink,price,user_product_id,attributes`;
    try {
      const result = await mlGet<Array<{ code: number; body: MlItem }>>(path);
      for (const entry of result) {
        if (entry.code !== 200 || !entry.body?.id) continue;
        const it = entry.body;
        const { error: upErr } = await supabase
          .from('ml_items_map')
          .update({
            titulo: it.title ?? null,
            family_name: it.family_name ?? null,
            thumbnail: it.thumbnail ?? null,
            permalink: it.permalink ?? null,
            price: it.price ?? null,
            user_product_id: it.user_product_id ?? null,
            bed_size: extractBedSize(it.attributes),
            attributes: it.attributes ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('item_id', it.id);
        if (upErr) {
          errors.push(`${it.id}: ${upErr.message}`);
        } else {
          synced++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`batch ${batch[0]}…: ${msg}`);
    }
  }

  return NextResponse.json({
    ok: true,
    requested: itemIds.length,
    synced,
    errors: errors.slice(0, 20),
    error_count: errors.length,
  });
}

// GET — quick status check: how many rows have family_name populated
export async function GET() {
  const supabase = getInventorySupabase();
  const [{ count: total }, { count: withFamily }, { count: withTitle }] = await Promise.all([
    supabase.from('ml_items_map').select('*', { count: 'exact', head: true }).eq('activo', true).is('variation_id', null),
    supabase.from('ml_items_map').select('*', { count: 'exact', head: true }).eq('activo', true).is('variation_id', null).not('family_name', 'is', null),
    supabase.from('ml_items_map').select('*', { count: 'exact', head: true }).eq('activo', true).is('variation_id', null).not('titulo', 'is', null),
  ]);

  return NextResponse.json({
    active_items: total ?? 0,
    with_family_name: withFamily ?? 0,
    with_titulo: withTitle ?? 0,
    pending_sync: (total ?? 0) - (withFamily ?? 0),
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { mlGet, mlReplaceItemPicturesFromUrls } from '@/lib/ml';

export const maxDuration = 60;

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

interface MlItemResponse {
  id: string;
  title: string;
  status: string;
  permalink: string;
  pictures: Array<{ id: string; secure_url: string; size: string }>;
}

const SELLER_ID = '1953806321';

async function resolveSkuToItemId(
  inventoryDb: ReturnType<typeof getInventorySupabase>,
  sku: string
): Promise<string | null> {
  // Try ml_items_map first
  const { data: mlItem } = await inventoryDb
    .from('ml_items_map')
    .select('item_id')
    .eq('sku_venta', sku)
    .eq('activo', true)
    .is('variation_id', null)
    .maybeSingle();

  if (mlItem?.item_id) return mlItem.item_id;

  // Auto-discover via ML API
  const search = await mlGet<{ results: string[] }>(
    `/users/${SELLER_ID}/items/search?seller_sku=${sku}&limit=1`
  );
  return search?.results?.[0] || null;
}

/**
 * GET /api/replicate-pictures?sku=XXX
 * Fetch listing info + pictures for a SKU
 */
export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get('sku');
  if (!sku) {
    return NextResponse.json({ error: 'sku parameter required' }, { status: 400 });
  }

  const inventoryDb = getInventorySupabase();
  const itemId = await resolveSkuToItemId(inventoryDb, sku);
  if (!itemId) {
    return NextResponse.json({ error: `SKU ${sku} not found in ML` }, { status: 404 });
  }

  const item = await mlGet<MlItemResponse>(
    `/items/${itemId}?attributes=id,title,status,permalink,pictures`
  );
  if (!item) {
    return NextResponse.json({ error: 'Failed to fetch ML item' }, { status: 500 });
  }

  return NextResponse.json({
    item_id: item.id,
    title: item.title,
    status: item.status,
    permalink: item.permalink,
    pictures: (item.pictures || []).map((p) => ({
      id: p.id,
      url: p.secure_url,
      size: p.size,
    })),
  });
}

/**
 * POST /api/replicate-pictures
 * Body: {
 *   source_sku: string,
 *   target_skus: string[],
 * }
 *
 * Copies pictures from source listing to each target listing.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const sourceSku: string | undefined = body.source_sku;
  const targetSkus: string[] | undefined = body.target_skus;

  if (!sourceSku) {
    return NextResponse.json({ error: 'source_sku is required' }, { status: 400 });
  }
  if (!targetSkus?.length) {
    return NextResponse.json({ error: 'target_skus is required (array)' }, { status: 400 });
  }

  const inventoryDb = getInventorySupabase();

  // 1. Resolve source
  const sourceItemId = await resolveSkuToItemId(inventoryDb, sourceSku);
  if (!sourceItemId) {
    return NextResponse.json({ error: `Source SKU ${sourceSku} not found in ML` }, { status: 404 });
  }

  // 2. Get source pictures
  const sourceItem = await mlGet<MlItemResponse>(
    `/items/${sourceItemId}?attributes=id,title,pictures`
  );
  if (!sourceItem?.pictures?.length) {
    return NextResponse.json({ error: 'Source listing has no pictures' }, { status: 400 });
  }

  // Use full-quality URLs (-F suffix)
  const sourceUrls = sourceItem.pictures.map((p) =>
    p.secure_url.replace(/-O\.(\w+)$/, '-F.$1')
  );

  // 3. Replicate to each target
  const results: Array<{
    sku: string;
    item_id: string | null;
    title: string | null;
    status: 'ok' | 'error';
    pictures_set: number;
    error?: string;
  }> = [];

  for (const targetSku of targetSkus) {
    try {
      const targetItemId = await resolveSkuToItemId(inventoryDb, targetSku);
      if (!targetItemId) {
        results.push({ sku: targetSku, item_id: null, title: null, status: 'error', pictures_set: 0, error: 'SKU not found in ML' });
        continue;
      }

      // Get target title for display
      const targetItem = await mlGet<{ id: string; title: string }>(
        `/items/${targetItemId}?attributes=id,title`
      );

      await mlReplaceItemPicturesFromUrls(targetItemId, sourceUrls);

      results.push({
        sku: targetSku,
        item_id: targetItemId,
        title: targetItem?.title || null,
        status: 'ok',
        pictures_set: sourceUrls.length,
      });
    } catch (err) {
      results.push({
        sku: targetSku,
        item_id: null,
        title: null,
        status: 'error',
        pictures_set: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const successCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  return NextResponse.json({
    source: { sku: sourceSku, item_id: sourceItemId, title: sourceItem.title, pictures: sourceUrls.length },
    targets: results,
    summary: { success: successCount, errors: errorCount, total: targetSkus.length },
  });
}

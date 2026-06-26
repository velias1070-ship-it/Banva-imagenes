import { NextRequest, NextResponse } from 'next/server';
import { mlGet, resolveItemIdForSku } from '@/lib/ml';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MlItemResponse {
  id: string;
  title: string;
  status: string;
  permalink: string;
  pictures: { id: string; secure_url: string; size: string; max_size: string }[];
}

/**
 * GET /api/projects/{id}/lookup-sku?sku=TXSB144IRK15P
 *
 * Looks up a SKU in ml_items_map, fetches ML listing data,
 * returns item_id + title + pictures for preview.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  await context.params; // consume params even though we don't need project id for lookup
  const sku = request.nextUrl.searchParams.get('sku')?.trim();

  if (!sku) {
    return NextResponse.json({ error: 'sku query parameter required' }, { status: 400 });
  }

  // 1. Resolve item_id via shared deterministic resolver
  let mlItem: { sku_venta: string; item_id: string; titulo: string } | null = null;

  const resolved = await resolveItemIdForSku(sku);

  if (resolved.item_id) {
    mlItem = { sku_venta: sku, item_id: resolved.item_id, titulo: '' };
  } else {
    // Try ML API search as fallback (only when the resolver found nothing)
    try {
      const sellerId = '1953806321';
      const searchResult = await mlGet<{ results: string[] }>(
        `/users/${sellerId}/items/search?seller_sku=${sku}&limit=1`
      );
      if (searchResult?.results?.[0]) {
        const foundItemId = searchResult.results[0];
        const itemData = await mlGet<{ id: string; title: string }>(
          `/items/${foundItemId}?attributes=id,title`
        );
        mlItem = {
          sku_venta: sku,
          item_id: foundItemId,
          titulo: itemData?.title || '',
        };
      }
    } catch (err) {
      console.error(`[lookup-sku] ML search failed for ${sku}:`, err);
    }
  }

  if (!mlItem) {
    return NextResponse.json({ error: `SKU "${sku}" no encontrado` }, { status: 404 });
  }

  // 2. Fetch full item from ML to get pictures
  try {
    const item = await mlGet<MlItemResponse>(
      `/items/${mlItem.item_id}?attributes=id,title,status,permalink,pictures`
    );

    return NextResponse.json({
      sku,
      item_id: mlItem.item_id,
      titulo: item.title || mlItem.titulo,
      status: item.status,
      permalink: item.permalink,
      pictures: (item.pictures || []).map((p) => ({
        id: p.id,
        url: p.secure_url,
        size: p.size,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      error: `Error obteniendo item ${mlItem.item_id} de ML: ${message}`,
    }, { status: 502 });
  }
}

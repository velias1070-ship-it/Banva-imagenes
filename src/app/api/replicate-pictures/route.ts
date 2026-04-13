import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { mlGet, mlPut, mlReplaceItemPicturesFromUrls, mlUploadImageFromUrl } from '@/lib/ml';

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
  seller_custom_field?: string | null;
  attributes?: Array<{ id: string; value_name?: string | null }>;
}

function extractSku(item: MlItemResponse): string | null {
  // Try seller_custom_field first (legacy)
  if (item.seller_custom_field) return item.seller_custom_field;
  // Then SELLER_SKU attribute
  const skuAttr = item.attributes?.find((a) => a.id === 'SELLER_SKU');
  return skuAttr?.value_name || null;
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
 * GET /api/replicate-pictures?sku=XXX — fetch listing by SKU
 * GET /api/replicate-pictures?q=XXX   — search seller listings by name
 * GET /api/replicate-pictures?item_id=MLC123 — fetch by item ID directly
 */
export async function GET(request: NextRequest) {
  const sku = request.nextUrl.searchParams.get('sku');
  const query = request.nextUrl.searchParams.get('q');
  const directItemId = request.nextUrl.searchParams.get('item_id');

  // Search by name — returns list of matching listings
  if (query) {
    // Normalize: strip trailing 's' from each word for better ML search matching
    // "infantiles" → "infantil", "plazas" → "plaza", "sabanas" → "sabana"
    const normalized = query
      .split(/\s+/)
      .map((w) => w.replace(/es$/i, '').replace(/s$/i, ''))
      .join(' ');

    // Search with normalized query, higher limit to get more results
    const searchRes = await mlGet<{
      results: string[];
      paging: { total: number };
    }>(`/users/${SELLER_ID}/items/search?q=${encodeURIComponent(normalized)}&limit=50`);

    if (!searchRes?.results?.length) {
      return NextResponse.json({ results: [] });
    }

    // Fetch details in batches of 20 (ML multi-get limit)
    const allIds = searchRes.results.slice(0, 50);
    const allItems: Array<{ code: number; body: MlItemResponse }> = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const batchIds = allIds.slice(i, i + 20);
      const batch = await mlGet<Array<{ code: number; body: MlItemResponse }>>(
        `/items?ids=${batchIds.join(',')}&attributes=id,title,status,permalink,pictures,seller_custom_field,attributes`
      );
      if (batch) allItems.push(...batch);
    }

    const results = allItems
      .filter((r) => r.code === 200 && r.body)
      .map((r) => ({
        item_id: r.body.id,
        title: r.body.title,
        status: r.body.status,
        permalink: r.body.permalink,
        picture_count: r.body.pictures?.length || 0,
        thumbnail: r.body.pictures?.[0]?.secure_url || null,
        sku: extractSku(r.body),
      }))
      // Sort: active first, then paused, then closed
      .sort((a, b) => {
        const order: Record<string, number> = { active: 0, paused: 1, closed: 2 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3);
      });

    return NextResponse.json({ results, total: searchRes.paging.total });
  }

  // Resolve item ID from SKU or direct
  let itemId: string | null = directItemId || null;

  if (!itemId && sku) {
    const inventoryDb = getInventorySupabase();
    itemId = await resolveSkuToItemId(inventoryDb, sku);
  }

  if (!itemId) {
    return NextResponse.json({ error: sku ? `SKU ${sku} not found in ML` : 'sku, q, or item_id parameter required' }, { status: sku ? 404 : 400 });
  }

  const item = await mlGet<MlItemResponse>(
    `/items/${itemId}?attributes=id,title,status,permalink,pictures,seller_custom_field,attributes`
  );
  if (!item) {
    return NextResponse.json({ error: 'Failed to fetch ML item' }, { status: 500 });
  }

  return NextResponse.json({
    item_id: item.id,
    title: item.title,
    status: item.status,
    permalink: item.permalink,
    sku: extractSku(item),
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
  const sourceItemIdDirect: string | undefined = body.source_item_id;
  const targetSkus: string[] | undefined = body.target_skus;
  const targetItemIds: string[] | undefined = body.target_item_ids;
  const selectedPictureIds: string[] | undefined = body.selected_picture_ids;
  const mode: 'replace_all' | 'swap_positions' | 'append' = body.mode || 'replace_all';
  const positionMappings: Array<{ source_index: number; target_index: number }> | undefined = body.position_mappings;
  const deletedTargetPictureIds: string[] | undefined = body.deleted_target_picture_ids;

  if (!sourceSku && !sourceItemIdDirect) {
    return NextResponse.json({ error: 'source_sku or source_item_id is required' }, { status: 400 });
  }
  if (!targetSkus?.length && !targetItemIds?.length) {
    return NextResponse.json({ error: 'target_skus or target_item_ids is required' }, { status: 400 });
  }

  const inventoryDb = getInventorySupabase();

  // 1. Resolve source
  let sourceItemId = sourceItemIdDirect || null;
  if (!sourceItemId && sourceSku) {
    sourceItemId = await resolveSkuToItemId(inventoryDb, sourceSku);
  }
  if (!sourceItemId) {
    return NextResponse.json({ error: `Source not found in ML` }, { status: 404 });
  }

  // 2. Get source pictures
  const sourceItem = await mlGet<MlItemResponse>(
    `/items/${sourceItemId}?attributes=id,title,pictures`
  );
  if (!sourceItem?.pictures?.length) {
    return NextResponse.json({ error: 'Source listing has no pictures' }, { status: 400 });
  }

  // Use full-quality URLs (-F suffix)
  const allSourceUrls = sourceItem.pictures.map((p) =>
    p.secure_url.replace(/-O\.(\w+)$/, '-F.$1')
  );

  // Filter to selected pictures if provided, otherwise use all
  let sourceUrls = allSourceUrls;
  if (selectedPictureIds && selectedPictureIds.length > 0) {
    sourceUrls = sourceItem.pictures
      .filter((p) => selectedPictureIds.includes(p.id))
      .map((p) => p.secure_url.replace(/-O\.(\w+)$/, '-F.$1'));
  }

  // For swap_positions mode, build a map of source index -> URL for the selected pictures
  const selectedPositionMap: Map<number, string> = new Map();
  if (mode === 'swap_positions' && selectedPictureIds && selectedPictureIds.length > 0) {
    for (let i = 0; i < sourceItem.pictures.length; i++) {
      if (selectedPictureIds.includes(sourceItem.pictures[i].id)) {
        const url = sourceItem.pictures[i].secure_url.replace(/-O\.(\w+)$/, '-F.$1');
        selectedPositionMap.set(i, url);
      }
    }
  }

  // 3. Build target list — merge SKUs and direct item IDs
  const targets: Array<{ label: string; itemId?: string; sku?: string }> = [];
  if (targetSkus?.length) {
    for (const s of targetSkus) targets.push({ label: s, sku: s });
  }
  if (targetItemIds?.length) {
    for (const id of targetItemIds) targets.push({ label: id, itemId: id });
  }

  // 4. Replicate to each target
  const results: Array<{
    sku: string;
    item_id: string | null;
    title: string | null;
    status: 'ok' | 'error';
    pictures_set: number;
    error?: string;
  }> = [];

  for (const target of targets) {
    try {
      let targetItemId = target.itemId || null;
      if (!targetItemId && target.sku) {
        targetItemId = await resolveSkuToItemId(inventoryDb, target.sku);
      }
      if (!targetItemId) {
        results.push({ sku: target.label, item_id: null, title: null, status: 'error', pictures_set: 0, error: 'Not found in ML' });
        continue;
      }

      if (mode === 'append') {
        // --- Append mode: add selected source photos to target without erasing existing ---
        // Optionally delete specific target picture IDs first.
        const targetItem = await mlGet<MlItemResponse>(
          `/items/${targetItemId}?attributes=id,title,pictures`
        );
        if (!targetItem) {
          results.push({ sku: target.label, item_id: targetItemId, title: null, status: 'error', pictures_set: 0, error: 'Failed to fetch target' });
          continue;
        }

        const existingPictures = targetItem.pictures || [];
        const remainingPictures: Array<{ id: string }> = existingPictures
          .filter((p) => !deletedTargetPictureIds?.includes(p.id))
          .map((p) => ({ id: p.id }));

        // Source URLs to add: only when user explicitly selected pictures
        const urlsToAdd: string[] = (selectedPictureIds && selectedPictureIds.length > 0)
          ? sourceItem.pictures
              .filter((p) => selectedPictureIds.includes(p.id))
              .map((p) => p.secure_url.replace(/-O\.(\w+)$/, '-F.$1'))
          : [];

        const deletedCount = existingPictures.length - remainingPictures.length;
        if (urlsToAdd.length === 0 && deletedCount === 0) {
          results.push({ sku: target.label, item_id: targetItemId, title: targetItem.title, status: 'error', pictures_set: 0, error: 'Nada que agregar ni borrar' });
          continue;
        }

        // Upload selected source photos to ML to obtain picture IDs
        const uploadedPictures: Array<{ id: string }> = [];
        for (const url of urlsToAdd) {
          const uploaded = await mlUploadImageFromUrl(url);
          uploadedPictures.push({ id: uploaded.id });
        }

        const mergedPictures = [...remainingPictures, ...uploadedPictures];

        await mlPut(`/items/${targetItemId}`, { pictures: mergedPictures });

        results.push({
          sku: target.label,
          item_id: targetItemId,
          title: targetItem.title,
          status: 'ok',
          pictures_set: mergedPictures.length,
        });
      } else if (mode === 'swap_positions') {
        // --- Swap by position mode ---
        // Get the target's current pictures
        const targetItem = await mlGet<MlItemResponse>(
          `/items/${targetItemId}?attributes=id,title,pictures`
        );
        if (!targetItem?.pictures?.length) {
          results.push({ sku: target.label, item_id: targetItemId, title: targetItem?.title || null, status: 'error', pictures_set: 0, error: 'Target has no pictures' });
          continue;
        }

        // Upload source photos to ML first so we get picture IDs
        // (using source URLs directly with mlPut is unreliable — ML may not reach the host)
        const uploadCache: Map<string, string> = new Map();
        let swappedCount = 0;

        // Build the merged pictures array: start with target's existing, replace at selected positions
        const mergedPictures: Array<{ id: string }> = targetItem.pictures.map((p) => ({ id: p.id }));

        if (positionMappings && positionMappings.length > 0) {
          // --- Manual mapping mode: source photo at source_index → target position at target_index ---
          for (const { source_index, target_index } of positionMappings) {
            if (source_index < 0 || source_index >= sourceItem.pictures.length) continue;
            if (target_index < 0 || target_index >= targetItem.pictures.length) continue;

            const sourceUrl = sourceItem.pictures[source_index].secure_url.replace(/-O\.(\w+)$/, '-F.$1');

            let uploadedId = uploadCache.get(sourceUrl);
            if (!uploadedId) {
              const uploaded = await mlUploadImageFromUrl(sourceUrl);
              uploadedId = uploaded.id;
              uploadCache.set(sourceUrl, uploadedId);
            }

            mergedPictures[target_index] = { id: uploadedId };
            swappedCount++;
          }
        } else {
          // --- Default same-position mode (using selectedPositionMap) ---
          for (const [sourceIndex, sourceUrl] of selectedPositionMap) {
            // Skip if position exceeds target's picture count
            if (sourceIndex >= targetItem.pictures.length) continue;

            // Upload source photo to ML (with cache to avoid re-uploading same URL)
            let uploadedId = uploadCache.get(sourceUrl);
            if (!uploadedId) {
              const uploaded = await mlUploadImageFromUrl(sourceUrl);
              uploadedId = uploaded.id;
              uploadCache.set(sourceUrl, uploadedId);
            }

            mergedPictures[sourceIndex] = { id: uploadedId };
            swappedCount++;
          }
        }

        if (swappedCount === 0) {
          results.push({ sku: target.label, item_id: targetItemId, title: targetItem.title, status: 'error', pictures_set: 0, error: 'No positions matched (target has fewer photos)' });
          continue;
        }

        // PUT the merged array to ML
        await mlPut(`/items/${targetItemId}`, { pictures: mergedPictures });

        results.push({
          sku: target.label,
          item_id: targetItemId,
          title: targetItem.title,
          status: 'ok',
          pictures_set: swappedCount,
        });
      } else {
        // --- Replace all mode (existing behavior) ---
        const targetItem = await mlGet<{ id: string; title: string }>(
          `/items/${targetItemId}?attributes=id,title`
        );

        await mlReplaceItemPicturesFromUrls(targetItemId, sourceUrls);

        results.push({
          sku: target.label,
          item_id: targetItemId,
          title: targetItem?.title || null,
          status: 'ok',
          pictures_set: sourceUrls.length,
        });
      }
    } catch (err) {
      results.push({
        sku: target.label,
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
    summary: { success: successCount, errors: errorCount, total: targets.length },
    mode,
  });
}

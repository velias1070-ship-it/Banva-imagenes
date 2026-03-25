import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { mlGet, mlPut, mlUploadImageFromUrl } from '@/lib/ml';

export const maxDuration = 120;

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

interface MlPicture {
  id: string;
  secure_url: string;
  size: string;
}

interface ReplicateRequest {
  source_sku: string;          // SKU to copy FROM (e.g. TXV23QLAT25BE)
  target_skus: string[];       // SKUs to copy TO (e.g. [TXV23QLAT20BE, TXV23QLAT30BE])
  cover_index?: number;        // Index of picture to use as cover in targets (0-based, default: same order as source)
  dry_run?: boolean;
}

/**
 * POST /api/ml/replicate-pictures
 *
 * Copies the exact images and order from one ML listing to others.
 * Useful for replicating across sizes (25P → 20P, 30P).
 *
 * Flow:
 * 1. Get source item pictures from ML
 * 2. Upload each picture to ML (so each target gets its own copy)
 * 3. PUT pictures to each target item in the same order
 */
export async function POST(request: NextRequest) {
  const body: ReplicateRequest = await request.json();
  const { source_sku, target_skus, cover_index, dry_run = false } = body;

  if (!source_sku || !target_skus?.length) {
    return NextResponse.json({ error: 'source_sku and target_skus[] are required' }, { status: 400 });
  }

  const inventoryDb = getInventorySupabase();

  // 1. Look up all SKUs → item_ids
  const allSkus = [source_sku, ...target_skus];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', allSkus)
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItem = new Map((mlItems || []).map((m) => [m.sku_venta, m]));

  const sourceItem = skuToItem.get(source_sku);
  if (!sourceItem) {
    return NextResponse.json({ error: `Source SKU ${source_sku} not found in ml_items_map` }, { status: 404 });
  }

  // 2. Get source pictures from ML
  const sourceData = await mlGet<{ pictures: MlPicture[] }>(`/items/${sourceItem.item_id}?attributes=pictures`);
  const sourcePictures = sourceData.pictures || [];

  if (!sourcePictures.length) {
    return NextResponse.json({ error: `Source listing ${sourceItem.item_id} has no pictures` }, { status: 400 });
  }

  // Reorder pictures if cover_index is specified
  let orderedPictures = [...sourcePictures];
  if (cover_index != null && cover_index >= 0 && cover_index < sourcePictures.length && cover_index !== 0) {
    const [cover] = orderedPictures.splice(cover_index, 1);
    orderedPictures.unshift(cover);
  }

  // 3. Process each target
  const results: {
    sku: string;
    item_id: string;
    titulo: string;
    pictures_count: number;
    status: 'success' | 'skipped' | 'error';
    error?: string;
  }[] = [];

  for (const targetSku of target_skus) {
    const targetItem = skuToItem.get(targetSku);
    if (!targetItem) {
      results.push({ sku: targetSku, item_id: '', titulo: '', pictures_count: 0, status: 'skipped', error: 'SKU not found in ml_items_map' });
      continue;
    }

    if (dry_run) {
      results.push({ sku: targetSku, item_id: targetItem.item_id, titulo: targetItem.titulo, pictures_count: sourcePictures.length, status: 'success' });
      continue;
    }

    try {
      // Upload each source picture to ML and collect new picture IDs
      const newPictureIds: { id: string }[] = [];
      for (const pic of orderedPictures) {
        const uploaded = await mlUploadImageFromUrl(pic.secure_url);
        newPictureIds.push({ id: uploaded.id });
      }

      // PUT to target item
      await mlPut(`/items/${targetItem.item_id}`, { pictures: newPictureIds });

      results.push({
        sku: targetSku,
        item_id: targetItem.item_id,
        titulo: targetItem.titulo,
        pictures_count: newPictureIds.length,
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ sku: targetSku, item_id: targetItem.item_id, titulo: targetItem.titulo, pictures_count: 0, status: 'error', error: message });
    }
  }

  return NextResponse.json({
    source: { sku: source_sku, item_id: sourceItem.item_id, titulo: sourceItem.titulo, pictures: sourcePictures.length },
    dry_run,
    targets: results,
    success: results.filter((r) => r.status === 'success').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  });
}

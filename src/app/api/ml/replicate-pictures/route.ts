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

interface PictureSource {
  type: 'ml' | 'generated';
  id?: string;
  url?: string;
  source_url?: string;
}

interface ReplicateRequest {
  source_sku: string;          // SKU to copy FROM (e.g. TXV23QLAT25BE)
  target_skus: string[];       // SKUs to copy TO (e.g. [TXV23QLAT20BE, TXV23QLAT30BE])
  cover_index?: number;        // Index of picture to use as cover in targets (0-based, default: same order as source)
  pictures?: PictureSource[];  // Custom arrangement from editor (mix of ML + generated)
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
  const { source_sku, target_skus, cover_index, pictures: customPictures, dry_run = false } = body;

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

  // 2. Resolve source image URLs
  let imageUrls: string[] = [];

  if (customPictures?.length) {
    // Custom arrangement from editor (mix of ML + generated)
    for (const pic of customPictures) {
      const url = pic.source_url || pic.url;
      if (pic.type === 'ml' && pic.id && sourceItem) {
        // Resolve ML picture URL
        const itemData = await mlGet<{ pictures: MlPicture[] }>(`/items/${sourceItem.item_id}?attributes=pictures`);
        const found = itemData.pictures?.find((p) => p.id === pic.id);
        if (found) imageUrls.push(found.secure_url);
      } else if (url) {
        imageUrls.push(url);
      }
    }
  } else if (sourceItem) {
    // Copy from source ML listing as-is
    const sourceData = await mlGet<{ pictures: MlPicture[] }>(`/items/${sourceItem.item_id}?attributes=pictures`);
    const sourcePictures = sourceData.pictures || [];

    // Reorder if cover_index specified
    if (cover_index != null && cover_index >= 0 && cover_index < sourcePictures.length && cover_index !== 0) {
      const reordered = [...sourcePictures];
      const [cover] = reordered.splice(cover_index, 1);
      reordered.unshift(cover);
      imageUrls = reordered.map((p) => p.secure_url);
    } else {
      imageUrls = sourcePictures.map((p) => p.secure_url);
    }
  }

  if (!imageUrls.length) {
    return NextResponse.json({ error: 'No pictures to replicate' }, { status: 400 });
  }

  // 3. Process each target
  const results: {
    sku: string; item_id: string; titulo: string;
    pictures_count: number; status: 'success' | 'skipped' | 'error'; error?: string;
  }[] = [];

  for (const targetSku of target_skus) {
    const targetItem = skuToItem.get(targetSku);
    if (!targetItem) {
      results.push({ sku: targetSku, item_id: '', titulo: '', pictures_count: 0, status: 'skipped', error: 'SKU not found in ml_items_map' });
      continue;
    }

    if (dry_run) {
      results.push({ sku: targetSku, item_id: targetItem.item_id, titulo: targetItem.titulo, pictures_count: imageUrls.length, status: 'success' });
      continue;
    }

    try {
      // Upload each image to ML for this target
      const newPictureIds: { id: string }[] = [];
      for (const url of imageUrls) {
        const uploaded = await mlUploadImageFromUrl(url);
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
    source: { sku: source_sku, item_id: sourceItem?.item_id || '', pictures: imageUrls.length },
    dry_run,
    targets: results,
    success: results.filter((r) => r.status === 'success').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  });
}

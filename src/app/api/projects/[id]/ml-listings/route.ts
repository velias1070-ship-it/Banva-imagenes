import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

interface MlPicture {
  id: string;
  secure_url: string;
  size: string;
  max_size: string;
}

interface MlItemResponse {
  id: string;
  title: string;
  status: string;
  permalink: string;
  pictures: MlPicture[];
}

export interface ListingData {
  swatch_id: string;
  swatch_name: string;
  sku: string;
  item_id: string;
  titulo: string;
  status: string;
  permalink: string;
  ml_pictures: { id: string; url: string; size: string }[];
  generated_images: { job_id: string; url: string; storage_path: string; shot_type: string; qa_score: number | null }[];
}

/**
 * GET /api/projects/{id}/ml-listings
 *
 * For each swatch/variant:
 * - Fetches current pictures from the ML listing
 * - Fetches approved generated images from the pipeline
 * Returns everything needed for the visual image manager.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/`;

  // Get swatches
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix')
    .eq('project_id', projectId)
    .order('display_order');

  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 404 });
  }

  // Get ML item mappings
  const skus = swatches.map((s) => s.sku_suffix).filter(Boolean) as string[];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', skus.length > 0 ? skus : ['__none__'])
    .eq('activo', true)
    .is('variation_id', null);

  const skuToMl = new Map((mlItems || []).map((m) => [m.sku_venta, m]));

  // Get approved jobs for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);

  const batchIds = (batches || []).map((b) => b.id);

  let approvedJobs: { id: string; swatch_id: string; hero_shot_id: string; output_storage_path: string; qa_score: number | null }[] = [];
  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('id, swatch_id, hero_shot_id, output_storage_path, qa_score')
      .eq('status', 'approved')
      .in('batch_id', batchIds)
      .not('output_storage_path', 'is', null);
    approvedJobs = jobs || [];
  }

  // Get hero shots for shot_type info
  const heroIds = [...new Set(approvedJobs.map((j) => j.hero_shot_id))];
  let heroMap = new Map<string, string>();
  if (heroIds.length > 0) {
    const { data: heroes } = await supabase
      .from('hero_shots')
      .select('id, shot_type')
      .in('id', heroIds);
    heroMap = new Map((heroes || []).map((h) => [h.id, h.shot_type || 'gen']));
  }

  // Build listings — fetch ML data in parallel
  const listings: ListingData[] = [];

  const mlFetches = swatches.map(async (swatch) => {
    // Generated images for this swatch
    const genImages = approvedJobs
      .filter((j) => j.swatch_id === swatch.id)
      .map((j) => ({
        job_id: j.id,
        url: `${storageBase}${j.output_storage_path}`,
        storage_path: j.output_storage_path,
        shot_type: heroMap.get(j.hero_shot_id) || 'gen',
        qa_score: j.qa_score,
      }));

    if (!skuToMl.has(swatch.sku_suffix || '') && swatch.sku_suffix) {
      // SKU not in ml_items_map — try to find it in ML and auto-insert
      try {
        const sellerId = '1953806321';
        const searchResult = await mlGet<{ results: string[] }>(
          `/users/${sellerId}/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
        );
        if (searchResult?.results?.[0]) {
          const foundItemId = searchResult.results[0];
          const itemData = await mlGet<{ id: string; title: string }>(
            `/items/${foundItemId}?attributes=id,title`
          );
          // Insert into ml_items_map
          await inventoryDb.from('ml_items_map').upsert({
            sku: swatch.sku_suffix,
            sku_venta: swatch.sku_suffix,
            item_id: foundItemId,
            titulo: itemData?.title || '',
            activo: true,
          }, { onConflict: 'sku_venta,item_id' });

          console.log(`[ml-listings] Auto-inserted ${swatch.sku_suffix} → ${foundItemId}`);
          // Set ml so the code below fetches pictures
          skuToMl.set(swatch.sku_suffix, { sku_venta: swatch.sku_suffix, item_id: foundItemId, titulo: itemData?.title || '' });
        }
      } catch (err) {
        console.error(`[ml-listings] Auto-insert failed for ${swatch.sku_suffix}:`, err);
      }
    }

    // Re-check after potential auto-insert
    const mlItem = swatch.sku_suffix ? skuToMl.get(swatch.sku_suffix) : null;

    if (!mlItem) {
      listings.push({
        swatch_id: swatch.id,
        swatch_name: swatch.name,
        sku: swatch.sku_suffix || '',
        item_id: '',
        titulo: '',
        status: '',
        permalink: '',
        ml_pictures: [],
        generated_images: genImages,
      });
      return;
    }

    try {
      const item = await mlGet<MlItemResponse>(`/items/${mlItem.item_id}?attributes=id,title,status,permalink,pictures`);
      listings.push({
        swatch_id: swatch.id,
        swatch_name: swatch.name,
        sku: swatch.sku_suffix || '',
        item_id: mlItem.item_id,
        titulo: item.title || mlItem.titulo,
        status: item.status || '',
        permalink: item.permalink || '',
        ml_pictures: (item.pictures || []).map((p) => ({
          id: p.id,
          url: p.secure_url,
          size: p.size,
        })),
        generated_images: genImages,
      });
    } catch {
      listings.push({
        swatch_id: swatch.id,
        swatch_name: swatch.name,
        sku: swatch.sku_suffix || '',
        item_id: mlItem.item_id,
        titulo: mlItem.titulo,
        status: 'error',
        permalink: '',
        ml_pictures: [],
        generated_images: genImages,
      });
    }
  });

  await Promise.all(mlFetches);

  // Sort by swatch display_order
  const swatchOrder = new Map(swatches.map((s, i) => [s.id, i]));
  listings.sort((a, b) => (swatchOrder.get(a.swatch_id) ?? 99) - (swatchOrder.get(b.swatch_id) ?? 99));

  return NextResponse.json(listings);
}

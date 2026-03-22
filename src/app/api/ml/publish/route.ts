import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlReplaceItemPicturesFromUrls } from '@/lib/ml';

// Inventory Supabase (ml_items_map, ml_config, productos)
function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

export const maxDuration = 60;

interface PublishRequest {
  project_id: string;
  job_ids?: string[];
  dry_run?: boolean;
}

interface PublishResult {
  sku: string;
  item_id: string;
  titulo: string;
  pictures_uploaded: number;
  status: 'success' | 'error' | 'skipped';
  error?: string;
}

/**
 * POST /api/ml/publish
 *
 * Publishes approved generated images to MercadoLibre listings.
 * Matches swatch.sku_suffix -> ml_items_map.sku_venta -> item_id
 */
export async function POST(request: NextRequest) {
  const body: PublishRequest = await request.json();
  const { project_id, job_ids, dry_run = false } = body;

  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1. Get batch IDs for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', project_id);

  if (!batches?.length) {
    return NextResponse.json({ error: 'No batches found for project' }, { status: 404 });
  }

  const batchIds = batches.map((b) => b.id);

  // 2. Get approved jobs
  let jobQuery = supabase
    .from('generation_jobs')
    .select('id, output_storage_path, swatch_id')
    .eq('status', 'approved')
    .in('batch_id', batchIds);

  if (job_ids?.length) {
    jobQuery = jobQuery.in('id', job_ids);
  }

  const { data: jobs, error: jobsError } = await jobQuery;

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }
  if (!jobs?.length) {
    return NextResponse.json({ error: 'No approved jobs found' }, { status: 404 });
  }

  // 3. Get swatches for these jobs
  const swatchIds = [...new Set(jobs.map((j) => j.swatch_id))];
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix')
    .in('id', swatchIds);

  const swatchMap = new Map((swatches || []).map((s) => [s.id, s]));

  // 4. Group jobs by swatch
  const bySwatch = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!bySwatch.has(job.swatch_id)) bySwatch.set(job.swatch_id, []);
    bySwatch.get(job.swatch_id)!.push(job);
  }

  // 5. Get ML item mappings (from inventory Supabase)
  const inventoryDb = getInventorySupabase();
  const allSkus = (swatches || [])
    .map((s) => s.sku_suffix)
    .filter(Boolean) as string[];

  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', allSkus.length > 0 ? allSkus : ['__none__'])
    .eq('activo', true);

  const skuToItem = new Map((mlItems || []).map((item) => [item.sku_venta, item]));

  // 6. Storage base URL
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/`;

  // 7. Process each SKU
  const results: PublishResult[] = [];

  for (const [swatchId, swatchJobs] of bySwatch) {
    const swatch = swatchMap.get(swatchId);
    const sku = swatch?.sku_suffix;

    if (!sku) {
      results.push({
        sku: swatch?.name || swatchId,
        item_id: '',
        titulo: '',
        pictures_uploaded: 0,
        status: 'skipped',
        error: 'No sku_suffix on swatch',
      });
      continue;
    }

    const mlItem = skuToItem.get(sku);
    if (!mlItem) {
      results.push({
        sku,
        item_id: '',
        titulo: '',
        pictures_uploaded: 0,
        status: 'skipped',
        error: `SKU ${sku} not found in ml_items_map`,
      });
      continue;
    }

    const imageUrls = swatchJobs
      .filter((j) => j.output_storage_path)
      .map((j) => `${storageBase}${j.output_storage_path}`);

    if (!imageUrls.length) {
      results.push({
        sku,
        item_id: mlItem.item_id,
        titulo: mlItem.titulo,
        pictures_uploaded: 0,
        status: 'skipped',
        error: 'No images with storage paths',
      });
      continue;
    }

    if (dry_run) {
      results.push({
        sku,
        item_id: mlItem.item_id,
        titulo: mlItem.titulo,
        pictures_uploaded: imageUrls.length,
        status: 'success',
      });
      continue;
    }

    try {
      await mlReplaceItemPicturesFromUrls(mlItem.item_id, imageUrls);
      results.push({
        sku,
        item_id: mlItem.item_id,
        titulo: mlItem.titulo,
        pictures_uploaded: imageUrls.length,
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sku,
        item_id: mlItem.item_id,
        titulo: mlItem.titulo,
        pictures_uploaded: 0,
        status: 'error',
        error: message,
      });
    }
  }

  return NextResponse.json({
    project_id,
    dry_run,
    total_skus: results.length,
    success: results.filter((r) => r.status === 'success').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    total_images: results.reduce((sum, r) => sum + r.pictures_uploaded, 0),
    details: results,
  });
}

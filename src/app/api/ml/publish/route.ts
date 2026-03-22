import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlUploadImageFromUrl, mlReplaceItemPicturesFromUrls } from '@/lib/ml';

export const maxDuration = 60;

interface PublishRequest {
  project_id: string;
  job_ids?: string[];  // Optional: specific jobs. If omitted, all approved jobs.
  dry_run?: boolean;   // Preview what would be published without actually doing it
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
 *
 * Flow per SKU:
 * 1. Find approved jobs for the project
 * 2. Match each swatch's sku_suffix → ml_items_map.sku_venta → item_id
 * 3. Get public URLs for the generated images from Supabase Storage
 * 4. PUT /items/{item_id} with the new picture source URLs
 */
export async function POST(request: NextRequest) {
  const body: PublishRequest = await request.json();
  const { project_id, job_ids, dry_run = false } = body;

  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1. Get approved jobs with their swatch info
  let query = supabase
    .from('generation_jobs')
    .select(`
      id,
      output_storage_path,
      hero_shot_id,
      swatch_id,
      swatch:swatches!inner(id, name, sku_suffix),
      hero_shot:hero_shots!inner(id, filename, shot_type)
    `)
    .eq('status', 'approved');

  if (job_ids?.length) {
    query = query.in('id', job_ids);
  } else {
    // Get all approved jobs for this project via batch
    const { data: batches } = await supabase
      .from('generation_batches')
      .select('id')
      .eq('project_id', project_id);

    if (!batches?.length) {
      return NextResponse.json({ error: 'No batches found for project' }, { status: 404 });
    }

    query = query.in('batch_id', batches.map((b) => b.id));
  }

  const { data: jobs, error: jobsError } = await query;

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  if (!jobs?.length) {
    return NextResponse.json({ error: 'No approved jobs found' }, { status: 404 });
  }

  // 2. Group jobs by swatch (each swatch = one SKU = one ML listing)
  const bySwatch = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const swatchId = job.swatch_id;
    if (!bySwatch.has(swatchId)) bySwatch.set(swatchId, []);
    bySwatch.get(swatchId)!.push(job);
  }

  // 3. Get ML item mappings for all SKUs
  const skuSuffixes = [...new Set(
    jobs
      .map((j) => (j.swatch as { sku_suffix: string | null })?.sku_suffix)
      .filter(Boolean) as string[]
  )];

  const { data: mlItems } = await supabase
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', skuSuffixes)
    .eq('activo', true);

  const skuToItem = new Map(
    (mlItems || []).map((item) => [item.sku_venta, item])
  );

  // 4. Get Supabase storage public URL base
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/`;

  // 5. Process each SKU
  const results: PublishResult[] = [];

  for (const [swatchId, swatchJobs] of bySwatch) {
    const swatch = swatchJobs[0].swatch as { id: string; name: string; sku_suffix: string | null };
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

    // Build public URLs for approved images
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

    // Actually publish to ML
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

  const summary = {
    project_id,
    dry_run,
    total_skus: results.length,
    success: results.filter((r) => r.status === 'success').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    total_images: results.reduce((sum, r) => sum + r.pictures_uploaded, 0),
    details: results,
  };

  return NextResponse.json(summary);
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import { ensureOutputSpec } from '@/lib/image-processing';

export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function buildCannonImageUrls(attrs: Record<string, string>): string[] {
  const design = attrs.FABRIC_DESIGN;
  const model = attrs.MODEL;
  const size = attrs.MATTRESS_SIZE;
  if (!design) return [];

  const designSlug = design
    .toLowerCase()
    .replace(/\s*\d+$/, '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const sizeSlug = (size || '2 plazas').toLowerCase().replace(/\s+/g, '-');
  const sizeCompact = sizeSlug.replace(/-/g, '');
  const threadMatch = (model || '').match(/(\d+)\s*hilos/i);
  const threadCount = threadMatch ? threadMatch[1] : '144';
  const designCompact = designSlug.replace(/-/g, '');

  // Cannon uses _1, _2, _3, etc. for multiple images
  const urls: string[] = [];
  for (let i = 1; i <= 10; i++) {
    urls.push(`https://cannonhome.cl/media/catalog/product/s/a/sabanas${sizeCompact}${threadCount}hilos${designCompact}_${i}.jpg`);
  }
  return urls;
}

/**
 * POST /api/projects/{id}/import-cannon
 * Body: { swatch_ids?: string[] } — optional filter, defaults to all swatches
 *
 * For each swatch:
 * 1. Gets ML item attributes (BRAND, FABRIC_DESIGN, etc.)
 * 2. Builds Cannon image URLs
 * 3. Downloads all available images
 * 4. Creates approved generation_jobs for each image
 *
 * Result: images appear in project results, ready to publish to ML.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();
  const body = await request.json().catch(() => ({}));
  const filterSwatchIds: string[] | undefined = body.swatch_ids;

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get swatches
  let swatchQuery = supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  const { data: swatches } = await swatchQuery;
  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 400 });
  }

  const targetSwatches = filterSwatchIds?.length
    ? swatches.filter((s) => filterSwatchIds.includes(s.id))
    : swatches;

  // Get or create a batch for imports
  let batchId: string;
  const { data: existingBatch } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingBatch?.length) {
    batchId = existingBatch[0].id;
  } else {
    const { data: newBatch } = await supabase
      .from('generation_batches')
      .insert({
        project_id: projectId,
        status: 'completed',
        total_combinations: 0,
        completed_count: 0,
        approved_count: 0,
        retry_count: 0,
        flagged_count: 0,
        error_count: 0,
      })
      .select()
      .single();
    batchId = newBatch!.id;
  }

  // We need a hero_shot to associate jobs with — create a placeholder if none exists
  let heroShotId: string;
  const { data: existingHero } = await supabase
    .from('hero_shots')
    .select('id')
    .eq('project_id', projectId)
    .limit(1);

  if (existingHero?.length) {
    heroShotId = existingHero[0].id;
  } else {
    const { data: newHero } = await supabase
      .from('hero_shots')
      .insert({
        project_id: projectId,
        filename: 'cannon-import',
        shot_type: 'main',
        storage_path: '',
        display_order: 0,
      })
      .select()
      .single();
    heroShotId = newHero!.id;
  }

  const results: {
    swatch: string;
    sku: string;
    images_imported: number;
    errors: string[];
  }[] = [];

  // Get all existing cannon imports for this project to avoid duplicates
  const batchIds = [batchId];
  const { data: allBatches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);
  if (allBatches) {
    for (const b of allBatches) {
      if (!batchIds.includes(b.id)) batchIds.push(b.id);
    }
  }

  const { data: existingJobs } = await supabase
    .from('generation_jobs')
    .select('swatch_id, prompt_metadata')
    .in('batch_id', batchIds)
    .eq('status', 'approved');

  const swatchesWithCannonImport = new Set<string>();
  for (const job of existingJobs || []) {
    const meta = job.prompt_metadata as Record<string, unknown> | null;
    if (meta?.strategy === 'cannon_import') {
      swatchesWithCannonImport.add(job.swatch_id);
    }
  }

  for (const swatch of targetSwatches) {
    if (!swatch.sku_suffix) {
      results.push({ swatch: swatch.name, sku: '', images_imported: 0, errors: ['No SKU'] });
      continue;
    }

    // Skip if already imported from Cannon
    if (swatchesWithCannonImport.has(swatch.id)) {
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: ['Ya importado de Cannon'] });
      continue;
    }

    const swatchResult = { swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: [] as string[] };

    try {
      // Find item_id
      const { data: mlItem } = await inventoryDb
        .from('ml_items_map')
        .select('item_id')
        .eq('sku_venta', swatch.sku_suffix)
        .eq('activo', true)
        .is('variation_id', null)
        .maybeSingle();

      let itemId = mlItem?.item_id;
      if (!itemId) {
        const search = await mlGet<{ results: string[] }>(
          `/users/1953806321/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
        );
        if (search?.results?.[0]) itemId = search.results[0];
      }

      if (!itemId) {
        swatchResult.errors.push('SKU not found in ML');
        results.push(swatchResult);
        continue;
      }

      // Get attributes
      const item = await mlGet<{
        attributes: Array<{ id: string; value_name: string | null }>;
      }>(`/items/${itemId}?attributes=attributes`);

      if (!item?.attributes) {
        swatchResult.errors.push('Could not fetch attributes');
        results.push(swatchResult);
        continue;
      }

      const attrs: Record<string, string> = {};
      for (const attr of item.attributes) {
        if (attr.value_name) attrs[attr.id] = attr.value_name;
      }

      const brand = (attrs.BRAND || '').toLowerCase();
      if (!brand.includes('cannon') && !brand.includes('american family')) {
        swatchResult.errors.push(`Not Cannon (brand: ${attrs.BRAND || 'unknown'})`);
        results.push(swatchResult);
        continue;
      }

      // Build Cannon URLs and try downloading each
      const imageUrls = buildCannonImageUrls(attrs);

      for (const url of imageUrls) {
        try {
          const res = await fetch(url, { headers: { 'Accept': 'image/*' } });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok || !contentType.startsWith('image/')) break; // No more images

          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 5000) break; // Too small, probably 404 page

          // Post-process to 1200x1200
          const processed = await ensureOutputSpec(buffer, 1200);

          // Upload
          const jobId = crypto.randomUUID();
          const storagePath = `projects/${projectId}/generated/${jobId}.png`;
          await supabase.storage.from('images').upload(storagePath, processed, {
            contentType: 'image/png',
            upsert: true,
          });

          // Create approved job
          await supabase.from('generation_jobs').insert({
            id: jobId,
            batch_id: batchId,
            hero_shot_id: heroShotId,
            swatch_id: swatch.id,
            status: 'approved',
            attempt: 0,
            output_storage_path: storagePath,
            qa_score: 1.0,
            prompt_metadata: {
              strategy: 'cannon_import',
              source_url: url,
              design: attrs.FABRIC_DESIGN,
            },
          });

          swatchResult.images_imported++;
        } catch {
          break; // Stop trying more images for this swatch
        }
      }
    } catch (err) {
      swatchResult.errors.push(err instanceof Error ? err.message : String(err));
    }

    results.push(swatchResult);
  }

  // Update batch counts
  const totalImported = results.reduce((sum, r) => sum + r.images_imported, 0);
  await supabase
    .from('generation_batches')
    .update({
      approved_count: totalImported,
      completed_count: totalImported,
      total_combinations: totalImported,
    })
    .eq('id', batchId);

  return NextResponse.json({
    total_swatches: results.length,
    total_images: totalImported,
    success: results.filter((r) => r.images_imported > 0).length,
    skipped: results.filter((r) => r.images_imported === 0 && r.errors.length === 0).length,
    errors: results.filter((r) => r.errors.length > 0).length,
    details: results,
  });
}

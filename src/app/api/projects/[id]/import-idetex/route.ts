import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import { ensureOutputSpec } from '@/lib/image-processing';
import {
  isIdetexSku,
  resolveIdetexProductUrl,
  extractAllProductImages,
  type IdetexResolveDebug,
} from '@/lib/idetex';

export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

/**
 * POST /api/projects/{id}/import-idetex
 * Body: { swatch_ids?: string[], force?: boolean }
 *
 * Bulk import Idetex product photos into a project. Provider validation goes
 * through productos.proveedor; URL resolution uses the shared scored matcher
 * in src/lib/idetex.ts. Works across plumones, frazadas, sábanas, quilts,
 * alfombras, etc. without per-family code.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();
  const body = await request.json().catch(() => ({}));
  const filterSwatchIds: string[] | undefined = body.swatch_ids;
  const force: boolean = body.force === true;

  const { data: project } = await supabase
    .from('projects')
    .select('id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 400 });
  }

  const targetSwatches = filterSwatchIds?.length
    ? swatches.filter((s) => filterSwatchIds.includes(s.id))
    : swatches;

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
        filename: 'idetex-import',
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
    debug?: {
      attrs?: Record<string, string>;
      provider_check?: string;
      resolve?: IdetexResolveDebug;
      product_url?: string | null;
      product_score?: number | null;
      image_urls?: string[];
    };
  }[] = [];

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

  const swatchesWithIdetexImport = new Set<string>();
  for (const job of existingJobs || []) {
    const meta = job.prompt_metadata as Record<string, unknown> | null;
    if (meta?.strategy === 'idetex_import') {
      swatchesWithIdetexImport.add(job.swatch_id);
    }
  }

  for (const swatch of targetSwatches) {
    if (!swatch.sku_suffix) {
      results.push({ swatch: swatch.name, sku: '', images_imported: 0, errors: ['No SKU'] });
      continue;
    }

    if (!force && swatchesWithIdetexImport.has(swatch.id)) {
      results.push({
        swatch: swatch.name,
        sku: swatch.sku_suffix,
        images_imported: 0,
        errors: ['Ya importado de Idetex'],
      });
      continue;
    }

    if (force && swatchesWithIdetexImport.has(swatch.id)) {
      const { data: oldJobs } = await supabase
        .from('generation_jobs')
        .select('id, output_storage_path, prompt_metadata')
        .in('batch_id', batchIds)
        .eq('swatch_id', swatch.id)
        .eq('status', 'approved');
      for (const oldJob of oldJobs || []) {
        const meta = oldJob.prompt_metadata as Record<string, unknown> | null;
        if (meta?.strategy === 'idetex_import') {
          if (oldJob.output_storage_path) {
            await supabase.storage.from('images').remove([oldJob.output_storage_path]);
          }
          await supabase.from('generation_jobs').delete().eq('id', oldJob.id);
        }
      }
    }

    const swatchResult: typeof results[number] = {
      swatch: swatch.name,
      sku: swatch.sku_suffix,
      images_imported: 0,
      errors: [],
      debug: {},
    };

    try {
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

      const item = await mlGet<{
        title: string;
        attributes: Array<{ id: string; value_name: string | null }>;
      }>(`/items/${itemId}?attributes=title,attributes`);

      if (!item?.attributes) {
        swatchResult.errors.push('Could not fetch attributes');
        results.push(swatchResult);
        continue;
      }

      const attrs: Record<string, string> = {};
      for (const attr of item.attributes) {
        if (attr.value_name) attrs[attr.id] = attr.value_name;
      }
      swatchResult.debug!.attrs = attrs;

      const provider = await isIdetexSku(swatch.sku_suffix, attrs);
      swatchResult.debug!.provider_check = provider.reason;
      if (!provider.ok) {
        swatchResult.errors.push(`Not Idetex — ${provider.reason}`);
        results.push(swatchResult);
        continue;
      }

      const { result: match, debug } = await resolveIdetexProductUrl(attrs, item.title);
      swatchResult.debug!.resolve = debug;
      swatchResult.debug!.product_url = match?.url ?? null;
      swatchResult.debug!.product_score = match?.score ?? null;

      if (!match) {
        swatchResult.errors.push(
          `No confident product match on idetex.cl (queries: ${debug.queries.join(' | ')})`
        );
        results.push(swatchResult);
        continue;
      }

      const imageUrls = await extractAllProductImages(match.url);
      swatchResult.debug!.image_urls = imageUrls;

      if (imageUrls.length === 0) {
        swatchResult.errors.push('No images found on product page');
        results.push(swatchResult);
        continue;
      }

      for (const url of imageUrls) {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
          });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok || !contentType.startsWith('image/')) continue;

          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 5000) continue;

          const processed = await ensureOutputSpec(buffer, 1200);

          const jobId = crypto.randomUUID();
          const storagePath = `projects/${projectId}/generated/${jobId}.png`;
          await supabase.storage.from('images').upload(storagePath, processed, {
            contentType: 'image/png',
            upsert: true,
          });

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
              strategy: 'idetex_import',
              source_url: url,
              product_url: match.url,
              match_score: match.score,
              match_query: match.query,
              design: attrs.FABRIC_DESIGN || attrs.COLOR,
              brand: attrs.BRAND,
            },
          });

          swatchResult.images_imported++;
        } catch {
          continue;
        }
      }
    } catch (err) {
      swatchResult.errors.push(err instanceof Error ? err.message : String(err));
    }

    results.push(swatchResult);
  }

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

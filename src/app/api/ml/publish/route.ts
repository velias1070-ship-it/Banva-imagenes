import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet, mlPut, mlUploadImageFromUrl } from '@/lib/ml';

// Inventory Supabase (ml_items_map, ml_config, productos)
function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

export const maxDuration = 60;

type InsertMode = 'prepend' | 'append' | 'replace';

interface PublishRequest {
  project_id: string;
  job_ids?: string[];
  dry_run?: boolean;
  mode?: InsertMode;        // default: 'prepend'
  max_pictures?: number;    // default: 10 (ML max varies by category)
  // When true, ignore the shot_type/display_order sort and publish jobs in the
  // exact order they appear in `job_ids`. Used by replicate-to-siblings so the
  // user-defined order survives all the way to ML.
  preserve_input_order?: boolean;
}

interface PublishResult {
  sku: string;
  item_id: string;
  titulo: string;
  pictures_new: number;
  pictures_kept: number;
  pictures_total: number;
  status: 'success' | 'error' | 'skipped';
  error?: string;
}

interface MlPicture {
  id: string;
  url?: string;
  secure_url?: string;
  size?: string;
}

/**
 * POST /api/ml/publish
 *
 * Smart publish: fetches existing pictures from ML, merges with new ones.
 *
 * Modes:
 * - prepend (default): new images first, then existing. Best for main/lifestyle shots.
 * - append: existing images first, then new ones at the end.
 * - replace: remove all existing, only use new images.
 *
 * Respects max_pictures limit (default 10) — trims from the end.
 */
export async function POST(request: NextRequest) {
  const body: PublishRequest = await request.json();
  const {
    project_id,
    job_ids,
    dry_run = false,
    mode = 'prepend',
    max_pictures = 10,
    preserve_input_order = false,
  } = body;

  const inputOrder = preserve_input_order && job_ids?.length
    ? new Map(job_ids.map((id, idx) => [id, idx]))
    : null;

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

  // 2. Get approved jobs with hero shot info for ordering
  let jobQuery = supabase
    .from('generation_jobs')
    .select('id, output_storage_path, swatch_id, hero_shot_id, prompt_metadata')
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

  // 3. Get hero shots for ordering (main first, then lifestyle, etc.)
  const heroIds = [...new Set(jobs.map((j) => j.hero_shot_id))];
  const { data: heroes } = await supabase
    .from('hero_shots')
    .select('id, shot_type, display_order')
    .in('id', heroIds);

  const heroMap = new Map((heroes || []).map((h) => [h.id, h]));

  // Shot type priority: main first, then lifestyle, detail, etc.
  const SHOT_ORDER: Record<string, number> = {
    main: 0, lifestyle: 1, detail: 2, doblada: 3, flatlay: 4,
  };

  // 4. Get swatches + project info for fallback matching
  const swatchIds = [...new Set(jobs.map((j) => j.swatch_id))];
  const [{ data: swatches }, { data: project }] = await Promise.all([
    supabase.from('swatches').select('id, name, sku_suffix').in('id', swatchIds),
    supabase.from('projects').select('name, category, sku_base').eq('id', project_id).single(),
  ]);

  const swatchMap = new Map((swatches || []).map((s) => [s.id, s]));

  // 5. Group jobs by effective SKU (target_sku for resized variants, swatch_id for normal)
  // Jobs with target_sku in prompt_metadata are 1.5P variants — group separately
  const bySku = new Map<string, { sku: string; jobs: typeof jobs }>();
  for (const job of jobs) {
    const meta = job.prompt_metadata as Record<string, unknown> | null;
    const targetSku = meta?.target_sku as string | undefined;

    if (targetSku) {
      // Resized variant — group by target_sku directly
      if (!bySku.has(targetSku)) bySku.set(targetSku, { sku: targetSku, jobs: [] });
      bySku.get(targetSku)!.jobs.push(job);
    } else {
      // Normal job — group by swatch_id (legacy behavior)
      const key = `swatch:${job.swatch_id}`;
      if (!bySku.has(key)) bySku.set(key, { sku: '', jobs: [] });
      bySku.get(key)!.jobs.push(job);
    }
  }

  // For swatch-grouped jobs, resolve SKU from swatch
  for (const [key, group] of bySku) {
    if (key.startsWith('swatch:')) {
      const swatchId = key.replace('swatch:', '');
      const swatch = swatchMap.get(swatchId);
      group.sku = swatch?.sku_suffix || '';
    }
  }

  // Legacy alias for compatibility with code below
  const bySwatch = new Map<string, typeof jobs>();
  for (const [, group] of bySku) {
    // Use sku as key (or generate a unique key for groups without sku)
    const groupKey = group.sku || `unknown-${Math.random()}`;
    bySwatch.set(groupKey, group.jobs);
  }

  // Sort each group. Default: by shot type priority (main → lifestyle → ...).
  // When preserve_input_order is set, use the position in the inputOrder map
  // instead — that's the order the caller passed via job_ids.
  for (const [, swatchJobs] of bySwatch) {
    if (inputOrder) {
      swatchJobs.sort((a, b) => (inputOrder.get(a.id) ?? 9999) - (inputOrder.get(b.id) ?? 9999));
    } else {
      swatchJobs.sort((a, b) => {
        const heroA = heroMap.get(a.hero_shot_id);
        const heroB = heroMap.get(b.hero_shot_id);
        const orderA = SHOT_ORDER[heroA?.shot_type || ''] ?? 99;
        const orderB = SHOT_ORDER[heroB?.shot_type || ''] ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return (heroA?.display_order ?? 99) - (heroB?.display_order ?? 99);
      });
    }
  }

  // 6. Get ML item mappings
  const inventoryDb = getInventorySupabase();
  const swatchSkus = (swatches || [])
    .map((s) => s.sku_suffix)
    .filter(Boolean) as string[];

  // Also collect target_skus from resized variants (1.5P jobs)
  const targetSkus = (jobs || [])
    .map((j) => (j.prompt_metadata as Record<string, unknown> | null)?.target_sku as string)
    .filter(Boolean);

  const allSkus = [...new Set([...swatchSkus, ...targetSkus])];

  // Also get all swatch names for fallback matching by title
  const swatchNames = (swatches || []).map((s) => s.name.toLowerCase());

  // Fetch ML items by SKU — only individual listings (no variations)
  let mlItems: { sku_venta: string; item_id: string; titulo: string }[] = [];
  if (allSkus.length > 0) {
    const { data } = await inventoryDb
      .from('ml_items_map')
      .select('sku_venta, item_id, titulo')
      .in('sku_venta', allSkus)
      .eq('activo', true)
      .is('variation_id', null);
    mlItems = data || [];
  }

  // If some swatches have no sku_suffix, try matching by title search
  const swatchesMissingSku = (swatches || []).filter((s) => !s.sku_suffix);
  if (swatchesMissingSku.length > 0 && project) {
    // Search ml_items_map by title containing project name + swatch color
    for (const sw of swatchesMissingSku) {
      const searchTerm = sw.name.toLowerCase();
      const { data: matches } = await inventoryDb
        .from('ml_items_map')
        .select('sku_venta, item_id, titulo')
        .ilike('titulo', `%${searchTerm}%`)
        .eq('activo', true)
        .is('variation_id', null)
        .limit(10);

      if (matches?.length) {
        // Try to find the best match: title should also contain something from the project name
        const projectWords = project.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
        const bestMatch = matches.find((m) =>
          projectWords.some((pw: string) => m.titulo.toLowerCase().includes(pw))
        ) || matches[0];

        if (bestMatch) {
          // Update the swatch's sku_suffix for future use
          await supabase
            .from('swatches')
            .update({ sku_suffix: bestMatch.sku_venta })
            .eq('id', sw.id);

          sw.sku_suffix = bestMatch.sku_venta;
          swatchMap.set(sw.id, sw);
          mlItems.push(bestMatch);
        }
      }
    }
  }

  const skuToItem = new Map(mlItems.map((item) => [item.sku_venta, item]));

  // 7. Storage base URL
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/images/`;

  // 8. Process each SKU
  const results: PublishResult[] = [];

  for (const [skuKey, swatchJobs] of bySwatch) {
    const sku = skuKey.startsWith('unknown-') ? null : skuKey;

    if (!sku) {
      results.push({
        sku: skuKey, item_id: '', titulo: '',
        pictures_new: 0, pictures_kept: 0, pictures_total: 0,
        status: 'skipped', error: 'No SKU assigned',
      });
      continue;
    }

    // If this SKU isn't in our map yet (e.g. a 1.5P target_sku), fetch it
    if (!skuToItem.has(sku)) {
      const { data: extraItems } = await inventoryDb
        .from('ml_items_map')
        .select('sku_venta, item_id, titulo')
        .eq('sku_venta', sku)
        .eq('activo', true)
        .is('variation_id', null)
        .limit(1);
      if (extraItems?.length) {
        skuToItem.set(sku, extraItems[0]);
      }
    }

    const mlItem = skuToItem.get(sku);
    if (!mlItem) {
      results.push({
        sku, item_id: '', titulo: '',
        pictures_new: 0, pictures_kept: 0, pictures_total: 0,
        status: 'skipped', error: `SKU ${sku} not found in ml_items_map`,
      });
      continue;
    }

    const newImageUrls = swatchJobs
      .filter((j) => j.output_storage_path)
      .map((j) => `${storageBase}${j.output_storage_path}`);

    if (!newImageUrls.length) {
      results.push({
        sku, item_id: mlItem.item_id, titulo: mlItem.titulo,
        pictures_new: 0, pictures_kept: 0, pictures_total: 0,
        status: 'skipped', error: 'No images with storage paths',
      });
      continue;
    }

    try {
      // Fetch current pictures from ML
      const itemData = await mlGet<{ pictures?: MlPicture[] }>(
        `/items/${mlItem.item_id}?attributes=pictures`
      );
      const existingPics = itemData.pictures || [];

      // Build the merged pictures array.
      // For new images: upload the binary to ML first to get permanent picture_ids.
      // Sending {source: url} directly lets ML download asynchronously — and when that
      // fetch fails the slot is stuck on the "processing-image" placeholder forever.
      // (Same failure mode as /api/replicate-pictures before it was fixed.)
      const existingEntries = existingPics.map((p) => ({ id: p.id }));

      let mergedPictures: { id: string }[];
      let keptCount: number;

      if (dry_run) {
        // Don't upload during dry-run — just estimate counts.
        let plannedNewCount: number;
        if (mode === 'replace') {
          plannedNewCount = Math.min(newImageUrls.length, max_pictures);
          keptCount = 0;
        } else if (mode === 'append') {
          const available = max_pictures - existingEntries.length;
          plannedNewCount = Math.max(0, Math.min(newImageUrls.length, available));
          keptCount = Math.min(existingEntries.length, max_pictures);
        } else {
          const newCount = Math.min(newImageUrls.length, max_pictures);
          const available = max_pictures - newCount;
          plannedNewCount = newCount;
          keptCount = Math.max(0, Math.min(existingEntries.length, available));
        }
        results.push({
          sku, item_id: mlItem.item_id, titulo: mlItem.titulo,
          pictures_new: plannedNewCount,
          pictures_kept: keptCount,
          pictures_total: plannedNewCount + keptCount,
          status: 'success',
        });
        continue;
      }

      // Real run: upload new images first.
      const newEntries: { id: string }[] = [];
      for (const url of newImageUrls) {
        const uploaded = await mlUploadImageFromUrl(url);
        newEntries.push({ id: uploaded.id });
      }

      if (mode === 'replace') {
        mergedPictures = newEntries;
        keptCount = 0;
      } else if (mode === 'append') {
        const available = max_pictures - existingEntries.length;
        const newToAdd = newEntries.slice(0, Math.max(0, available));
        mergedPictures = [...existingEntries, ...newToAdd];
        keptCount = existingEntries.length;
      } else {
        // prepend (default): new first, then fill with existing
        const available = max_pictures - newEntries.length;
        const existingToKeep = existingEntries.slice(0, Math.max(0, available));
        mergedPictures = [...newEntries, ...existingToKeep];
        keptCount = existingToKeep.length;
      }

      // Enforce max
      mergedPictures = mergedPictures.slice(0, max_pictures);

      // PUT to ML
      await mlPut(`/items/${mlItem.item_id}`, { pictures: mergedPictures });

      results.push({
        sku, item_id: mlItem.item_id, titulo: mlItem.titulo,
        pictures_new: newImageUrls.length,
        pictures_kept: keptCount,
        pictures_total: mergedPictures.length,
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sku, item_id: mlItem.item_id, titulo: mlItem.titulo,
        pictures_new: 0, pictures_kept: 0, pictures_total: 0,
        status: 'error', error: message,
      });
    }
  }

  return NextResponse.json({
    project_id,
    dry_run,
    mode,
    total_skus: results.length,
    success: results.filter((r) => r.status === 'success').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    total_new_images: results.reduce((sum, r) => sum + r.pictures_new, 0),
    total_kept_images: results.reduce((sum, r) => sum + r.pictures_kept, 0),
    details: results,
  });
}

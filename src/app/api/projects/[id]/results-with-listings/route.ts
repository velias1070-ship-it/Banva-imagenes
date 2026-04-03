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

interface SwatchData {
  id: string;
  name: string;
  sku_suffix: string | null;
  color_description: string | null;
  storage_path: string;
  display_order: number;
}

interface JobData {
  id: string;
  status: string;
  attempt: number;
  output_storage_path: string | null;
  qa_score: number | null;
  qa_feedback: string | null;
  qa_detail: Record<string, number | undefined> | null;
  error_message: string | null;
  swatch_id: string | null;
  hero_shot: { filename: string; shot_type: string; storage_path: string } | null;
  swatch: { id: string; name: string; color_description: string | null; storage_path: string; display_order: number } | null;
}

interface MlListingData {
  item_id: string;
  titulo: string;
  status: string;
  permalink: string;
  ml_pictures: Array<{ id: string; url: string; size: string }>;
}

interface SwatchResultGroup {
  swatch: {
    id: string;
    name: string;
    sku_suffix: string | null;
    color_description: string | null;
    storage_path: string;
    display_order: number;
  };
  jobs: Array<{
    id: string;
    status: string;
    attempt: number;
    output_storage_path: string | null;
    qa_score: number | null;
    qa_feedback: string | null;
    qa_detail: Record<string, number | undefined> | null;
    error_message: string | null;
    hero_shot: { filename: string; shot_type: string; storage_path: string } | null;
    swatch: { id: string; name: string; color_description: string | null; storage_path: string; display_order: number } | null;
  }>;
  ml_listing: MlListingData | null;
}

/**
 * GET /api/projects/{id}/results-with-listings
 *
 * Combined endpoint that returns:
 * - All generation jobs (any status) grouped by swatch
 * - ML listing data for each swatch (fetched in parallel)
 * - Jobs without a swatch grouped under "__no_swatch__"
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // 1. Fetch batches for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);

  if (!batches?.length) {
    return NextResponse.json([]);
  }

  const batchIds = batches.map((b) => b.id);

  // 2. Fetch ALL jobs with hero_shot and swatch relations (same as results endpoint)
  const { data: jobs, error: jobsError } = await supabase
    .from('generation_jobs')
    .select(
      `*, hero_shot:hero_shots(filename, shot_type, storage_path), swatch:swatches(id, name, color_description, storage_path, display_order)`
    )
    .in('batch_id', batchIds)
    .order('created_at', { ascending: true });

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  const allJobs = (jobs || []) as JobData[];

  // 3. Fetch ALL swatches for the project
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, color_description, storage_path, display_order')
    .eq('project_id', projectId)
    .order('display_order');

  const allSwatches = (swatches || []) as SwatchData[];

  // 4. Fetch ML item mappings from inventory DB
  const skus = allSwatches.map((s) => s.sku_suffix).filter(Boolean) as string[];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', skus.length > 0 ? skus : ['__none__'])
    .eq('activo', true)
    .is('variation_id', null);

  const skuToMl = new Map((mlItems || []).map((m) => [m.sku_venta, m]));

  // 5. Auto-discover unmapped SKUs + fetch ML listing data in parallel
  const mlListingsBySwatch = new Map<string, MlListingData | null>();

  const mlFetches = allSwatches.map(async (swatch) => {
    // Auto-discover logic for unmapped SKUs
    if (!skuToMl.has(swatch.sku_suffix || '') && swatch.sku_suffix) {
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
          await inventoryDb.from('ml_items_map').upsert(
            {
              sku: swatch.sku_suffix,
              sku_venta: swatch.sku_suffix,
              item_id: foundItemId,
              titulo: itemData?.title || '',
              activo: true,
            },
            { onConflict: 'sku_venta,item_id' }
          );
          console.log(`[results-with-listings] Auto-inserted ${swatch.sku_suffix} -> ${foundItemId}`);
          skuToMl.set(swatch.sku_suffix, {
            sku_venta: swatch.sku_suffix,
            item_id: foundItemId,
            titulo: itemData?.title || '',
          });
        }
      } catch (err) {
        console.error(`[results-with-listings] Auto-insert failed for ${swatch.sku_suffix}:`, err);
      }
    }

    // Re-check after potential auto-insert
    const mlItem = swatch.sku_suffix ? skuToMl.get(swatch.sku_suffix) : null;

    if (!mlItem) {
      mlListingsBySwatch.set(swatch.id, null);
      return;
    }

    try {
      const item = await mlGet<MlItemResponse>(
        `/items/${mlItem.item_id}?attributes=id,title,status,permalink,pictures`
      );
      mlListingsBySwatch.set(swatch.id, {
        item_id: mlItem.item_id,
        titulo: item.title || mlItem.titulo,
        status: item.status || '',
        permalink: item.permalink || '',
        ml_pictures: (item.pictures || []).map((p) => ({
          id: p.id,
          url: p.secure_url,
          size: p.size,
        })),
      });
    } catch {
      // ML fetch failed — set null so the request doesn't crash
      mlListingsBySwatch.set(swatch.id, null);
    }
  });

  await Promise.all(mlFetches);

  // 6. Group jobs by swatch
  const swatchMap = new Map(allSwatches.map((s) => [s.id, s]));
  const jobsBySwatchId = new Map<string, JobData[]>();

  for (const job of allJobs) {
    const key = job.swatch_id || '__no_swatch__';
    const existing = jobsBySwatchId.get(key);
    if (existing) {
      existing.push(job);
    } else {
      jobsBySwatchId.set(key, [job]);
    }
  }

  // 7. Build result groups
  const groups: SwatchResultGroup[] = [];

  // Groups for each swatch (ordered by display_order)
  for (const swatch of allSwatches) {
    const swatchJobs = jobsBySwatchId.get(swatch.id) || [];

    groups.push({
      swatch: {
        id: swatch.id,
        name: swatch.name,
        sku_suffix: swatch.sku_suffix,
        color_description: swatch.color_description,
        storage_path: swatch.storage_path,
        display_order: swatch.display_order,
      },
      jobs: swatchJobs.map((j) => ({
        id: j.id,
        status: j.status,
        attempt: j.attempt,
        output_storage_path: j.output_storage_path,
        qa_score: j.qa_score,
        qa_feedback: j.qa_feedback,
        qa_detail: j.qa_detail,
        error_message: j.error_message,
        hero_shot: j.hero_shot,
        swatch: j.swatch,
      })),
      ml_listing: mlListingsBySwatch.get(swatch.id) ?? null,
    });
  }

  // Group for jobs without a swatch
  const noSwatchJobs = jobsBySwatchId.get('__no_swatch__');
  if (noSwatchJobs?.length) {
    groups.push({
      swatch: {
        id: '__no_swatch__',
        name: 'Sin swatch',
        sku_suffix: null,
        color_description: null,
        storage_path: '',
        display_order: 999,
      },
      jobs: noSwatchJobs.map((j) => ({
        id: j.id,
        status: j.status,
        attempt: j.attempt,
        output_storage_path: j.output_storage_path,
        qa_score: j.qa_score,
        qa_feedback: j.qa_feedback,
        qa_detail: j.qa_detail,
        error_message: j.error_message,
        hero_shot: j.hero_shot,
        swatch: j.swatch,
      })),
      ml_listing: null,
    });
  }

  return NextResponse.json(groups);
}

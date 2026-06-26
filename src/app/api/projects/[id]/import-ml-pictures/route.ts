import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet, resolveItemIdForSku } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MlPicture {
  id: string;
  secure_url: string;
  size: string;
}

interface MlItemResponse {
  id: string;
  pictures: MlPicture[];
}

/**
 * POST /api/projects/{id}/import-ml-pictures
 * Body: { swatch_id: string }
 *
 * Downloads pictures from the ML listing for the swatch's SKU
 * and creates approved generation_jobs so they appear in results.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const body = await request.json().catch(() => ({}));

  const swatchId: string | undefined = body.swatch_id;
  const selectedPictureIds: string[] | undefined = body.picture_ids; // Optional: only import these ML picture IDs
  if (!swatchId) {
    return NextResponse.json({ error: 'swatch_id is required' }, { status: 400 });
  }

  // Get swatch
  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix')
    .eq('id', swatchId)
    .single();

  if (!swatch) {
    return NextResponse.json({ error: 'Swatch not found' }, { status: 404 });
  }
  if (!swatch.sku_suffix) {
    return NextResponse.json({ error: 'Swatch has no SKU linked' }, { status: 400 });
  }

  // Find ML item via shared deterministic resolver
  const resolved = await resolveItemIdForSku(swatch.sku_suffix);
  let itemId: string | null = resolved.item_id;
  if (!itemId) {
    // Auto-discover (fallback only when resolver finds nothing)
    const search = await mlGet<{ results: string[] }>(
      `/users/1953806321/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
    );
    if (search?.results?.[0]) itemId = search.results[0];
  }

  if (!itemId) {
    return NextResponse.json({ error: `SKU ${swatch.sku_suffix} not found in ML` }, { status: 400 });
  }

  // Get pictures from ML
  const item = await mlGet<MlItemResponse>(
    `/items/${itemId}?attributes=id,pictures`
  );
  if (!item?.pictures?.length) {
    return NextResponse.json({ error: 'No pictures found on ML listing' }, { status: 400 });
  }

  // Check for existing ML imports for this swatch (avoid duplicates)
  const { data: allBatches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);

  const batchIds = (allBatches || []).map((b) => b.id);

  // Map ml_picture_id → job_id for existing ML imports of this swatch (will be replaced)
  const existingByPicId = new Map<string, string>();
  if (batchIds.length > 0) {
    const { data: existingJobs } = await supabase
      .from('generation_jobs')
      .select('id, prompt_metadata')
      .in('batch_id', batchIds)
      .eq('swatch_id', swatchId);

    for (const j of existingJobs || []) {
      const meta = j.prompt_metadata as Record<string, unknown> | null;
      if (meta?.strategy === 'ml_import' && typeof meta?.ml_picture_id === 'string') {
        existingByPicId.set(meta.ml_picture_id, j.id);
      }
    }
  }

  // Get or create a completed batch
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

  // Filter pictures by selection if provided
  const picturesToImport = selectedPictureIds?.length
    ? item.pictures.filter((p) => selectedPictureIds.includes(p.id))
    : item.pictures;

  if (!picturesToImport.length) {
    return NextResponse.json({ error: 'None of the selected pictures were found on the ML listing' }, { status: 400 });
  }

  // Delete jobs for pictures we're about to re-import (overwrite with fresh copy)
  const idsToReplace = picturesToImport
    .map((p) => existingByPicId.get(p.id))
    .filter((id): id is string => !!id);
  if (idsToReplace.length > 0) {
    await supabase.from('generation_jobs').delete().in('id', idsToReplace);
    console.log(`[import-ml] Replacing ${idsToReplace.length} existing pictures with fresh copies`);
  }

  // Download and import each picture
  let imported = 0;
  for (const pic of picturesToImport) {
    const imageUrl = pic.secure_url.replace(/-O\.(\w+)$/, '-F.$1');

    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 1000) continue;

      const jobId = crypto.randomUUID();
      const ext = imageUrl.includes('.webp') ? 'webp' : 'png';
      const storagePath = `projects/${projectId}/generated/${jobId}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('images')
        .upload(storagePath, buffer, {
          contentType: ext === 'webp' ? 'image/webp' : 'image/png',
          upsert: true,
        });

      if (uploadErr) continue;

      await supabase.from('generation_jobs').insert({
        id: jobId,
        batch_id: batchId,
        hero_shot_id: null,
        swatch_id: swatchId,
        status: 'approved',
        attempt: 0,
        output_storage_path: storagePath,
        qa_score: 1.0,
        qa_feedback: 'Importado de MercadoLibre',
        prompt_adjustment: 'ML_IMPORT',
        prompt_metadata: {
          strategy: 'ml_import',
          source_url: imageUrl,
          ml_picture_id: pic.id,
          item_id: itemId,
        },
      });

      imported++;
    } catch {
      continue;
    }
  }

  if (imported === 0) {
    return NextResponse.json({ error: 'Failed to download any ML images' }, { status: 500 });
  }

  // Update batch counts
  await supabase.rpc('increment_batch_counts', {
    p_batch_id: batchId,
    p_approved: imported,
    p_completed: imported,
    p_total: imported,
  }).then(() => {}, () => {
    // Fallback if RPC doesn't exist
    supabase
      .from('generation_batches')
      .select('approved_count, completed_count, total_combinations')
      .eq('id', batchId)
      .single()
      .then(({ data }) => {
        if (data) {
          supabase.from('generation_batches').update({
            approved_count: (data.approved_count || 0) + imported,
            completed_count: (data.completed_count || 0) + imported,
            total_combinations: (data.total_combinations || 0) + imported,
          }).eq('id', batchId);
        }
      });
  });

  return NextResponse.json({
    imported,
    total_ml_pictures: item.pictures.length,
    selected_pictures: picturesToImport.length,
    swatch: swatch.name,
    sku: swatch.sku_suffix,
  });
}

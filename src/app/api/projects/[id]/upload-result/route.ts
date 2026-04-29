import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIN_SIZE_BYTES = 1000;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

interface FinalizeBody {
  job_id?: string;
  storage_path?: string;
  swatch_id?: string;
  mime_type?: string;
  size_bytes?: number;
  original_filename?: string | null;
}

/**
 * POST /api/projects/{id}/upload-result
 *
 * Finalizes a direct-to-Supabase upload performed via the signed URL from
 * /upload-result/sign. The route verifies the object exists in Storage,
 * then inserts an approved generation_job (strategy = "user_upload") so
 * the image shows up in the variant's results, same shape as ML-imported
 * pictures.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;

  let body: FinalizeBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { job_id: jobId, storage_path: storagePath, swatch_id: swatchId, mime_type: mimeType } = body;
  const sizeBytes = body.size_bytes;
  const originalFilename = body.original_filename ?? null;

  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 });
  }
  if (typeof storagePath !== 'string' || !storagePath) {
    return NextResponse.json({ error: 'storage_path is required' }, { status: 400 });
  }
  if (typeof swatchId !== 'string' || !swatchId) {
    return NextResponse.json({ error: 'swatch_id is required' }, { status: 400 });
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME.has(mimeType)) {
    return NextResponse.json({ error: `Unsupported mime_type ${mimeType ?? ''}` }, { status: 400 });
  }
  if (typeof sizeBytes !== 'number' || sizeBytes < MIN_SIZE_BYTES || sizeBytes > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: `size_bytes out of range (${sizeBytes ?? 'missing'})` }, { status: 400 });
  }
  if (!storagePath.startsWith(`projects/${projectId}/generated/`)) {
    return NextResponse.json({ error: 'storage_path does not belong to project' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, project_id')
    .eq('id', swatchId)
    .single();
  if (!swatch || swatch.project_id !== projectId) {
    return NextResponse.json({ error: 'Swatch not found in project' }, { status: 404 });
  }

  // Verify the object actually exists in Storage. list() against the parent
  // folder filtered by filename is the cheapest way without downloading.
  const slashIdx = storagePath.lastIndexOf('/');
  const folder = storagePath.slice(0, slashIdx);
  const filename = storagePath.slice(slashIdx + 1);
  const { data: listed, error: listErr } = await supabase.storage
    .from('images')
    .list(folder, { search: filename, limit: 1 });
  if (listErr) {
    return NextResponse.json({ error: `Storage check failed: ${listErr.message}` }, { status: 500 });
  }
  const found = listed?.find((o) => o.name === filename);
  if (!found) {
    return NextResponse.json({ error: 'Uploaded object not found in storage' }, { status: 404 });
  }

  // Reuse an existing completed batch or create one, same pattern as import-ml-pictures.
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
    const { data: newBatch, error: batchErr } = await supabase
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
    if (batchErr || !newBatch) {
      return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
    }
    batchId = newBatch.id;
  }

  const { error: insertErr } = await supabase.from('generation_jobs').insert({
    id: jobId,
    batch_id: batchId,
    hero_shot_id: null,
    swatch_id: swatchId,
    status: 'approved',
    attempt: 0,
    output_storage_path: storagePath,
    qa_score: 1.0,
    qa_feedback: 'Subido manualmente',
    prompt_adjustment: 'USER_UPLOAD',
    prompt_metadata: {
      strategy: 'user_upload',
      original_filename: originalFilename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    },
  });

  if (insertErr) {
    await supabase.storage.from('images').remove([storagePath]);
    return NextResponse.json({ error: `Insert failed: ${insertErr.message}` }, { status: 500 });
  }

  await supabase.rpc('increment_batch_counts', {
    p_batch_id: batchId,
    p_approved: 1,
    p_completed: 1,
    p_total: 1,
  }).then(() => {}, () => {
    supabase
      .from('generation_batches')
      .select('approved_count, completed_count, total_combinations')
      .eq('id', batchId)
      .single()
      .then(({ data }) => {
        if (data) {
          supabase.from('generation_batches').update({
            approved_count: (data.approved_count || 0) + 1,
            completed_count: (data.completed_count || 0) + 1,
            total_combinations: (data.total_combinations || 0) + 1,
          }).eq('id', batchId);
        }
      });
  });

  return NextResponse.json({
    job_id: jobId,
    output_storage_path: storagePath,
    swatch: swatch.name,
  });
}

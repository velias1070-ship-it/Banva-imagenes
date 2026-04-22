import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

/**
 * POST /api/projects/{id}/upload-result
 * Multipart: file (image), swatch_id
 *
 * Stores the uploaded image as an approved generation_job so it shows up in the
 * variant's results, same shape as ML-imported pictures. strategy = "user_upload".
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const swatchId = form.get('swatch_id');
  const file = form.get('file');

  if (typeof swatchId !== 'string' || !swatchId) {
    return NextResponse.json({ error: 'swatch_id is required' }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: `Unsupported type ${file.type}` }, { status: 400 });
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 15MB' }, { status: 400 });
  }

  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, project_id')
    .eq('id', swatchId)
    .single();
  if (!swatch || swatch.project_id !== projectId) {
    return NextResponse.json({ error: 'Swatch not found in project' }, { status: 404 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 1000) {
    return NextResponse.json({ error: 'File too small' }, { status: 400 });
  }

  const jobId = crypto.randomUUID();
  const ext = extFromMime(file.type);
  const storagePath = `projects/${projectId}/generated/${jobId}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, { contentType: file.type, upsert: true });

  if (uploadErr) {
    return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
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
      original_filename: file.name || null,
      mime_type: file.type,
      size_bytes: buffer.length,
    },
  });

  if (insertErr) {
    // Best-effort cleanup — the file uploaded but the job row didn't persist.
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

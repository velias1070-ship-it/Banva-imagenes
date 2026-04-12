import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

/**
 * Diagnostic endpoint — pass a job ID, get every piece of trace data
 * relevant to debugging why the image came out the way it did.
 *
 * Returns: core fields + pipeline log timeline + prompt that was sent +
 * full verifier sub-scores + full QA per-dimension reasoning + signed URLs
 * for hero/swatch/output so you can eyeball the images.
 *
 * Consumed by humans for post-hoc debugging. Not for production clients.
 * GET /api/debug/jobs/{jobId}
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(id, storage_path, mime_type, shot_type, detected_shot_type, text_elements),
      swatch:swatches(id, name, storage_path, sku_suffix, dominant_color_hex, color_description)
    `)
    .eq('id', jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: 'Job not found', detail: error?.message }, { status: 404 });
  }

  // Sign the image URLs so the user can actually view them
  const signUrl = async (path: string | null | undefined) => {
    if (!path) return null;
    const { data } = await supabase.storage.from('images').createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  };

  const [heroUrl, swatchUrl, outputUrl] = await Promise.all([
    signUrl((job.hero_shot as Record<string, string> | null)?.storage_path),
    signUrl((job.swatch as Record<string, string>)?.storage_path),
    signUrl(job.output_storage_path),
  ]);

  // Build the timeline — pipeline_log is already ordered by append
  const timeline = Array.isArray(job.pipeline_log) ? job.pipeline_log : [];

  // Extract the verifier sub-scores and QA reasons for a clean view
  const verRaw = (job.verification_raw || {}) as Record<string, unknown>;
  const qaDetail = (job.qa_detail || {}) as Record<string, unknown>;
  const promptMetadata = (job.prompt_metadata || {}) as Record<string, unknown>;

  // Compute per-stage timing from the pipeline log
  const eventTs = (name: string): string | null => {
    const ev = timeline.find((e: Record<string, unknown>) => e.event === name);
    return (ev?.ts as string) || null;
  };
  const pickedUp = eventTs('PICKED_UP');
  const genStart = eventTs('GENERATION_START');
  const genDone = eventTs('GENERATION_DONE');
  const verPass = eventTs('VERIFICATION');
  const uploadedAt = eventTs('UPLOAD');
  const msBetween = (a: string | null, b: string | null) =>
    a && b ? new Date(b).getTime() - new Date(a).getTime() : null;

  return NextResponse.json({
    id: job.id,
    batch_id: job.batch_id,
    status: job.status,
    attempt: job.attempt,
    worker: {
      claimed_by: job.claimed_by,
      claimed_at: job.claimed_at,
      worker_id: job.worker_id,
    },
    core: {
      shot_type_db: (job.hero_shot as Record<string, string> | null)?.shot_type || null,
      shot_type_detected: (job.hero_shot as Record<string, string> | null)?.detected_shot_type || null,
      category: promptMetadata.category || null,
      mode: promptMetadata.strategy || null,
      temperature: promptMetadata.temperature || null,
      flatten_hero: promptMetadata.flatten_hero || null,
      crop_swatch: promptMetadata.crop_swatch || null,
      pattern_similarity: promptMetadata.pattern_similarity ?? null,
      pattern_auto_switch_reason: promptMetadata.pattern_auto_switch_reason ?? null,
      force_edit: promptMetadata.force_edit ?? null,
      force_edit_reason: promptMetadata.force_edit_reason ?? null,
      swatch_hex: promptMetadata.swatch_hex ?? null,
      swatch_color: promptMetadata.swatch_color ?? null,
      swatch_pattern_text: job.swatch_pattern_text ?? null,
      gemini_model: job.gemini_model_used || null,
      total_api_calls: job.total_api_calls || 0,
    },
    timing_ms: {
      total_generation: msBetween(pickedUp, uploadedAt),
      generation_only: msBetween(genStart, genDone),
      verification: msBetween(genDone, verPass),
    },
    prompt: {
      text: job.prompt_text || null,
      length: (job.prompt_text || '').length,
    },
    verifier: {
      pass: verRaw.pass ?? null,
      score: verRaw.score ?? null,
      feedback: verRaw.feedback ?? null,
      issues: verRaw.issues ?? [],
      checks: verRaw.checks ?? null,             // per-dimension sub-scores
      raw_response: verRaw.raw_response ?? null, // full Gemini text response
      duration_ms: verRaw.duration_ms ?? null,
    },
    qa: {
      score: job.qa_score,
      feedback: job.qa_feedback,
      detail: qaDetail,
      reasons: qaDetail._reasons ?? null,  // per-dimension reasoning
      raw_response: qaDetail._raw ?? null, // full Gemini text response
      action: promptMetadata.qa_action ?? null,
      reason: promptMetadata.qa_reason ?? null,
    },
    gemini_response_meta: job.gemini_response_meta || null,
    images: {
      hero: heroUrl,
      swatch: swatchUrl,
      output: outputUrl,
      hero_path: (job.hero_shot as Record<string, string> | null)?.storage_path || null,
      swatch_path: (job.swatch as Record<string, string>)?.storage_path || null,
      output_path: job.output_storage_path || null,
    },
    error: {
      message: job.error_message || null,
      code: job.error_code || null,
    },
    timeline,
    created_at: job.created_at,
    updated_at: job.updated_at,
  });
}

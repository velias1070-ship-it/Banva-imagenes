import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';

export const maxDuration = 60;

function getBaseUrl() {
  return (
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000'
  );
}

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

// POST /api/projects/[id]/swatches/[swatchId]/replicate-to-siblings
//
// Clona los jobs aprobados del swatch fuente a una lista de swatches destino,
// reutilizando los mismos output_storage_path (mismas imagenes ya generadas).
// No genera nada nuevo en Gemini — solo copia filas de generation_jobs.
//
// Body:
//   { target_swatch_ids: string[],
//     also_publish_to_ml?: boolean,    // default false — cuando true, sube las
//                                       // fotos clonadas a las publicaciones ML
//                                       // de cada swatch destino
//     publish_mode?: 'prepend' | 'append' | 'replace' }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const targetIds: string[] = Array.isArray(body.target_swatch_ids)
    ? body.target_swatch_ids.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const alsoPublishToMl: boolean = body.also_publish_to_ml === true;
  const publishMode: 'prepend' | 'append' | 'replace' =
    body.publish_mode === 'append' || body.publish_mode === 'replace' ? body.publish_mode : 'prepend';

  if (targetIds.length === 0) {
    return NextResponse.json({ error: 'target_swatch_ids requerido' }, { status: 400 });
  }
  if (targetIds.includes(swatchId)) {
    return NextResponse.json({ error: 'no podes replicar al mismo swatch' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: targets, error: tgtErr } = await supabase
    .from('swatches')
    .select('id, project_id')
    .in('id', targetIds)
    .eq('project_id', projectId);
  if (tgtErr) return NextResponse.json({ error: tgtErr.message }, { status: 500 });
  if (!targets?.length) return NextResponse.json({ error: 'targets no encontrados' }, { status: 404 });

  const { data: sourceJobs, error: srcErr } = await supabase
    .from('generation_jobs')
    .select('hero_shot_id, prompt_text, prompt_metadata, output_storage_path, qa_score, qa_detail, qa_feedback, gemini_model_used, generation_time_ms, prompt_adjustment, status, attempt')
    .eq('swatch_id', swatchId)
    .eq('status', 'approved')
    .not('output_storage_path', 'is', null);
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
  if (!sourceJobs?.length) {
    return NextResponse.json({ error: 'el swatch fuente no tiene jobs aprobados' }, { status: 400 });
  }

  const total = sourceJobs.length * targets.length;
  const { data: batch, error: batchErr } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'completed',
      total_combinations: total,
      completed_count: total,
      approved_count: total,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: 0, // gratis — solo clona refs
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (batchErr || !batch) return NextResponse.json({ error: batchErr?.message || 'no se pudo crear batch' }, { status: 500 });

  const replicatedFromMeta = { replicated_from_swatch_id: swatchId };

  const newJobs: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    for (const src of sourceJobs) {
      const meta = (src.prompt_metadata as Record<string, unknown> | null) || {};
      newJobs.push({
        batch_id: batch.id,
        hero_shot_id: src.hero_shot_id,
        swatch_id: target.id,
        status: 'approved',
        attempt: src.attempt ?? 0,
        prompt_text: src.prompt_text,
        prompt_metadata: { ...meta, ...replicatedFromMeta },
        output_storage_path: src.output_storage_path,
        qa_score: src.qa_score,
        qa_detail: src.qa_detail,
        qa_feedback: src.qa_feedback,
        gemini_model_used: src.gemini_model_used,
        generation_time_ms: 0,
        prompt_adjustment: src.prompt_adjustment,
      });
    }
  }

  const { data: insertedJobs, error: insErr } = await supabase
    .from('generation_jobs')
    .insert(newJobs)
    .select('id');
  if (insErr) {
    // rollback the batch
    await supabase.from('generation_batches').delete().eq('id', batch.id);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  void COST_PER_IMAGE_USD;

  // Optionally push the cloned images to MercadoLibre right after cloning.
  // Reuses /api/ml/publish so all the merge/dedupe/order logic stays in one
  // place. Each target swatch with an ML listing gets its pictures updated.
  let publishResult: unknown = null;
  if (alsoPublishToMl && insertedJobs?.length) {
    try {
      const publishRes = await fetch(`${getBaseUrl()}/api/ml/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          job_ids: insertedJobs.map((j) => j.id),
          mode: publishMode,
        }),
      });
      publishResult = await publishRes.json().catch(() => ({ error: 'invalid json' }));
    } catch (err) {
      publishResult = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json({
    ok: true,
    batch_id: batch.id,
    source_jobs: sourceJobs.length,
    targets: targets.length,
    jobs_inserted: newJobs.length,
    publish: publishResult,
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logPipelineEvent } from '@/lib/pipeline-log';

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * POST /api/batches/{batchId}/stop
 *
 * User-triggered soft stop. Prevents the serverless chain from picking up more
 * work, without forcibly killing in-flight Gemini calls (Vercel serverless can't
 * abort a running request safely — it'd orphan storage writes).
 *
 * - Batch → "halted". process-next early-exits when halted and no attempt=0 pending.
 * - process-qa already suppresses retries when batch is halted (→ flagged instead of new pending).
 * - Pending jobs (attempt=0, never started) → "error" with user-cancel marker. This both frees
 *   the halt check and prevents a race where process-next tries to claim them.
 * - generating / qa_pending / qa_processing jobs are left alone — they drain naturally (~25s).
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;
  const supabase = createAdminClient();

  const { data: batch, error: batchErr } = await supabase
    .from('generation_batches')
    .select('id, status')
    .eq('id', batchId)
    .single();

  if (batchErr || !batch) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  }

  if (batch.status === 'completed' || batch.status === 'failed') {
    return NextResponse.json({
      error: `Batch already ${batch.status}`,
      batch_status: batch.status,
    }, { status: 409 });
  }

  const now = new Date().toISOString();

  // Cancel pending jobs first — this ensures the halt check in process-next
  // ("never-processed pending" = count > 0 ⇒ un-halt) finds nothing to resurrect.
  const { data: pendingJobs, error: pendingErr } = await supabase
    .from('generation_jobs')
    .update({
      status: 'error',
      error_message: 'Cancelado por usuario',
      updated_at: now,
    })
    .eq('batch_id', batchId)
    .eq('status', 'pending')
    .select('id');

  if (pendingErr) {
    return NextResponse.json({ error: `Cancel pending failed: ${pendingErr.message}` }, { status: 500 });
  }

  const cancelledCount = pendingJobs?.length ?? 0;

  // Halt the batch. process-qa already treats halted as "no more retries".
  await supabase
    .from('generation_batches')
    .update({ status: 'halted', updated_at: now })
    .eq('id', batchId);

  // Count in-flight (generating) and qa_pending/qa_processing — user should know these drain.
  const [inFlightRes, qaPendingRes] = await Promise.all([
    supabase
      .from('generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'generating'),
    supabase
      .from('generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['qa_pending', 'qa_processing']),
  ]);

  for (const job of pendingJobs ?? []) {
    logPipelineEvent(job.id, 'CANCELLED', 'Cancelado por usuario');
  }

  return NextResponse.json({
    batch_id: batchId,
    cancelled_pending: cancelledCount,
    in_flight: inFlightRes.count ?? 0,
    qa_draining: qaPendingRes.count ?? 0,
  });
}

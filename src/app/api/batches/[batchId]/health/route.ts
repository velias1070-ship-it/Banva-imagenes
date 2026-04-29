import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { CHAIN_STALE_THRESHOLD_MS } from '@/lib/constants';
import { logPipelineEvent } from '@/lib/pipeline-log';

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * Chain health check — detects stale jobs and relaunches broken chains.
 * Handles THREE stale statuses:
 *   - generating: Gemini API timeout → reset to pending
 *   - qa_pending: QA chain broke → relaunch QA
 *   - qa_processing: QA function died mid-scoring → reset to qa_pending
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;
  const supabase = createAdminClient();

  // Get batch info
  const { data: batch } = await supabase
    .from('generation_batches')
    .select('*')
    .eq('id', batchId)
    .single();

  if (!batch) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  }

  // Skip if batch is already completed or failed (nothing to do)
  if (['completed', 'failed'].includes(batch.status)) {
    return NextResponse.json({
      status: batch.status,
      message: 'Batch is not active',
    });
  }

  // Halted batches: still check for qa_pending/qa_processing jobs
  const batchIsHalted = batch.status === 'halted';

  const staleThreshold = new Date(Date.now() - CHAIN_STALE_THRESHOLD_MS).toISOString();

  // Check for stale generating jobs (stuck in generation).
  // Sprint 5 Issue #0a (race condition fix): also require claimed_at to be
  // older than the threshold. Without this, a job whose worker is mid-flight
  // (claimed recently, no event-driven updated_at touch yet because the
  // adapter is in a long generation call) gets falsely flagged as stale and
  // reset, allowing a parallel claim → two workers race the same job.
  const { data: staleGenerating } = await supabase
    .from('generation_jobs')
    .select('id, status, updated_at, claimed_at, claimed_by')
    .eq('batch_id', batchId)
    .eq('status', 'generating')
    .lt('updated_at', staleThreshold)
    .lt('claimed_at', staleThreshold)
    .limit(10);

  // Check for stale qa_pending jobs (QA chain might have died)
  const { data: staleQaPending } = await supabase
    .from('generation_jobs')
    .select('id, status, updated_at')
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .lt('updated_at', staleThreshold)
    .limit(10);

  // Check for stale qa_processing jobs (QA function died mid-scoring).
  // Sprint 5 Issue #0a: also require claimed_at to be older than the
  // threshold. Same defensive pattern as the generating reset above —
  // protects against rescuing a row whose process-qa worker is mid-flight.
  // Note: claimed_at on a qa_processing row reflects the original generation
  // claim (process-qa doesn't re-claim), so this filter mostly excludes rows
  // claimed within the last 5 minutes (i.e., generation just finished and
  // QA started). The optimistic UPDATE below is the strong defense.
  const { data: staleQaProcessing } = await supabase
    .from('generation_jobs')
    .select('id, status, updated_at, claimed_at, claimed_by')
    .eq('batch_id', batchId)
    .eq('status', 'qa_processing')
    .lt('updated_at', staleThreshold)
    .lt('claimed_at', staleThreshold)
    .limit(10);

  // Check for pending jobs that should be processed
  const { count: pendingCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .eq('status', 'pending');

  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  const actions: string[] = [];

  // ── RESET stale qa_processing → qa_pending ──
  // These are jobs where the QA function died mid-scoring.
  // Sprint 5 Issue #0a: optimistic lock — only flip if the row is STILL in
  // qa_processing AND updated_at is STILL stale at write time. If the QA
  // worker just heartbeated, the UPDATE no-ops and we log
  // STALE_QA_PROCESSING_RESCUE_ABORTED instead of clobbering its work.
  if ((staleQaProcessing?.length || 0) > 0) {
    let rescued = 0;
    let aborted = 0;
    for (const job of staleQaProcessing || []) {
      const { data: updated } = await supabase
        .from('generation_jobs')
        .update({
          status: 'qa_pending',
          error_message: 'Reset by health check — stale qa_processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
        .eq('status', 'qa_processing')
        .lt('updated_at', staleThreshold)
        .select('id')
        .maybeSingle();
      if (updated) {
        rescued += 1;
      } else {
        aborted += 1;
        logPipelineEvent(job.id, 'STALE_QA_PROCESSING_RESCUE_ABORTED', 'health endpoint: QA worker still mid-flight or already moved — skipping reset', { batch_id: batchId });
      }
    }
    if (rescued > 0) actions.push(`Reset ${rescued} stale qa_processing → qa_pending`);
    if (aborted > 0) actions.push(`Skipped ${aborted} qa_processing — already moved or mid-flight`);
  }

  // ── RESET stale generating → pending ──
  // Sprint 5 Issue #0a: optimistic lock — the UPDATE only matches if the row
  // is STILL stale at write time (status='generating' AND updated_at hasn't
  // moved since the SELECT). If a worker just published a heartbeat, the
  // UPDATE no-ops and we log STALE_RESCUE_ABORTED instead of clobbering it.
  if (!batchIsHalted && (staleGenerating?.length || 0) > 0) {
    let rescued = 0;
    let aborted = 0;
    for (const job of staleGenerating || []) {
      const { data: updated } = await supabase
        .from('generation_jobs')
        .update({
          status: 'pending',
          error_message: 'Reset by health check — stale generating',
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
        .eq('status', 'generating')
        .lt('updated_at', staleThreshold)
        .select('id')
        .maybeSingle();
      if (updated) {
        rescued += 1;
      } else {
        aborted += 1;
        logPipelineEvent(job.id, 'STALE_RESCUE_ABORTED', 'health endpoint: worker still owns claim — skipping reset', { batch_id: batchId });
      }
    }
    if (rescued > 0) actions.push(`Reset ${rescued} stale generating → pending`);
    if (aborted > 0) actions.push(`Skipped ${aborted} stale candidates — claim still owned`);
  } else if (batchIsHalted && (staleGenerating?.length || 0) > 0) {
    actions.push(`Batch halted — ${staleGenerating?.length} stale generating jobs skipped`);
  }

  // ── RELAUNCH generation chain if needed ──
  if (!batchIsHalted) {
    const needsGeneration = (staleGenerating?.length || 0) > 0 || (pendingCount || 0) > 0;
    if (needsGeneration) {
      try {
        await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        actions.push('Relaunched generation chain (process-next)');
      } catch (err) {
        actions.push(`Failed to relaunch generation: ${err}`);
      }
    }
  }

  // ── RELAUNCH QA chain if stale qa_pending OR recovered qa_processing ──
  const needsQA = (staleQaPending?.length || 0) > 0 || (staleQaProcessing?.length || 0) > 0;
  if (needsQA) {
    try {
      await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      actions.push(`Relaunched QA chain — ${(staleQaPending?.length || 0)} stale qa_pending, ${(staleQaProcessing?.length || 0)} recovered qa_processing`);
    } catch (err) {
      actions.push(`Failed to relaunch QA: ${err}`);
    }
  }

  // Get summary counts
  const { data: statusCounts } = await supabase
    .from('generation_jobs')
    .select('status')
    .eq('batch_id', batchId);

  const counts: Record<string, number> = {};
  for (const job of statusCounts || []) {
    counts[job.status] = (counts[job.status] || 0) + 1;
  }

  return NextResponse.json({
    batch_id: batchId,
    batch_status: batch.status,
    job_counts: counts,
    stale_generating: staleGenerating?.length || 0,
    stale_qa_pending: staleQaPending?.length || 0,
    stale_qa_processing: staleQaProcessing?.length || 0,
    pending: pendingCount || 0,
    actions,
    checked_at: new Date().toISOString(),
  });
}

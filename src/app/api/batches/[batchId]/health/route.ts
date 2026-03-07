import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { CHAIN_STALE_THRESHOLD_MS } from '@/lib/constants';

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * Chain health check — detects stale jobs and relaunches broken chains.
 * Can be called manually or via Vercel Cron (every 5 min).
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

  // Skip if batch is already completed, halted, or failed
  if (['completed', 'halted', 'failed'].includes(batch.status)) {
    return NextResponse.json({
      status: batch.status,
      message: 'Batch is not active',
    });
  }

  const staleThreshold = new Date(Date.now() - CHAIN_STALE_THRESHOLD_MS).toISOString();

  // Check for stale generating jobs (stuck in generation)
  const { data: staleGenerating } = await supabase
    .from('generation_jobs')
    .select('id, status, updated_at')
    .eq('batch_id', batchId)
    .eq('status', 'generating')
    .lt('updated_at', staleThreshold)
    .limit(5);

  // Check for stale qa_pending jobs (QA chain might have died)
  const { data: staleQaPending } = await supabase
    .from('generation_jobs')
    .select('id, status, updated_at')
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .lt('updated_at', staleThreshold)
    .limit(5);

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

  // Relaunch generation chain if stale generating jobs OR pending jobs exist
  if ((staleGenerating?.length || 0) > 0) {
    // Reset stale generating jobs back to pending
    for (const job of staleGenerating || []) {
      await supabase
        .from('generation_jobs')
        .update({
          status: 'pending',
          error_message: 'Reset by health check — stale generating',
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
    actions.push(`Reset ${staleGenerating?.length} stale generating jobs to pending`);
  }

  if ((staleGenerating?.length || 0) > 0 || (pendingCount || 0) > 0) {
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

  // Relaunch QA chain if stale qa_pending jobs exist
  if ((staleQaPending?.length || 0) > 0) {
    try {
      await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      actions.push(`Relaunched QA chain — ${staleQaPending?.length} stale qa_pending jobs`);
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
    pending: pendingCount || 0,
    actions,
    checked_at: new Date().toISOString(),
  });
}

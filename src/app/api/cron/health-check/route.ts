import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { CHAIN_STALE_THRESHOLD_MS } from '@/lib/constants';

/**
 * CRON HEALTH CHECK — Auto-heals broken generation/QA chains.
 *
 * Finds ALL active batches (status = 'generating') and for each:
 * 1. Resets stale 'generating' jobs back to 'pending'
 * 2. Relaunches generation chain if pending jobs exist
 * 3. Relaunches QA chain if stale qa_pending jobs exist
 *
 * Can be called by:
 * - Vercel Cron (vercel.json)
 * - Client-side polling from the generate page
 *
 * Secured with CRON_SECRET for Vercel Cron, but also accepts
 * project_id param for client-side calls (scoped to one project).
 */
export async function GET(request: NextRequest) {
  const supabase = createAdminClient();

  // Optional: scope to a single project (for client-side calls)
  const projectId = request.nextUrl.searchParams.get('project_id');

  // Verify cron secret for Vercel Cron calls (not required for client-side)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  // Find all active batches
  let query = supabase
    .from('generation_batches')
    .select('id, project_id, status')
    .in('status', ['generating', 'halted']);

  if (projectId) {
    query = query.eq('project_id', projectId);
  }

  const { data: activeBatches } = await query;

  if (!activeBatches?.length) {
    return NextResponse.json({
      message: 'No active batches',
      checked_at: new Date().toISOString(),
    });
  }

  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  const staleThreshold = new Date(Date.now() - CHAIN_STALE_THRESHOLD_MS).toISOString();
  const results: Array<{ batch_id: string; actions: string[] }> = [];

  for (const batch of activeBatches) {
    const actions: string[] = [];
    const batchIsHalted = batch.status === 'halted';

    // Check for stale generating jobs
    const { data: staleGenerating } = await supabase
      .from('generation_jobs')
      .select('id')
      .eq('batch_id', batch.id)
      .eq('status', 'generating')
      .lt('updated_at', staleThreshold);

    // Check for stale qa_pending jobs
    const { data: staleQaPending } = await supabase
      .from('generation_jobs')
      .select('id')
      .eq('batch_id', batch.id)
      .eq('status', 'qa_pending')
      .lt('updated_at', staleThreshold);

    // Check for stale qa_processing jobs (QA function died mid-scoring)
    const { data: staleQaProcessing } = await supabase
      .from('generation_jobs')
      .select('id')
      .eq('batch_id', batch.id)
      .eq('status', 'qa_processing')
      .lt('updated_at', staleThreshold);

    // Check for pending jobs
    const { count: pendingCount } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch.id)
      .eq('status', 'pending');

    // Reset stale qa_processing → qa_pending
    if ((staleQaProcessing?.length || 0) > 0) {
      for (const job of staleQaProcessing!) {
        await supabase
          .from('generation_jobs')
          .update({
            status: 'qa_pending',
            error_message: 'Reset by cron health check — stale qa_processing',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
      }
      actions.push(`Reset ${staleQaProcessing!.length} stale qa_processing → qa_pending`);
    }

    // Reset stale generating → pending
    if (!batchIsHalted && (staleGenerating?.length || 0) > 0) {
      for (const job of staleGenerating!) {
        await supabase
          .from('generation_jobs')
          .update({
            status: 'pending',
            error_message: 'Reset by cron health check — stale generating',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
      }
      actions.push(`Reset ${staleGenerating!.length} stale generating jobs`);
    }

    // Relaunch generation chain
    if (!batchIsHalted && ((staleGenerating?.length || 0) > 0 || (pendingCount || 0) > 0)) {
      try {
        await fetch(`${baseUrl}/api/batches/${batch.id}/process-next`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        actions.push(`Relaunched generation chain (${pendingCount} pending)`);
      } catch (err) {
        actions.push(`Failed to relaunch generation: ${err}`);
      }
    }

    // Relaunch QA chain (for stale qa_pending OR recovered qa_processing)
    const needsQARelaunch = (staleQaPending?.length || 0) > 0 || (staleQaProcessing?.length || 0) > 0;
    if (needsQARelaunch) {
      try {
        await fetch(`${baseUrl}/api/batches/${batch.id}/process-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        actions.push(`Relaunched QA chain (${staleQaPending?.length || 0} stale qa_pending, ${staleQaProcessing?.length || 0} recovered qa_processing)`);
      } catch (err) {
        actions.push(`Failed to relaunch QA: ${err}`);
      }
    }

    if (actions.length > 0) {
      results.push({ batch_id: batch.id, actions });
    }
  }

  return NextResponse.json({
    active_batches: activeBatches.length,
    healed: results,
    is_cron: isCronCall || false,
    checked_at: new Date().toISOString(),
  });
}

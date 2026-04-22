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

  // Find all active batches + completed batches that still have pending/stuck jobs
  let query = supabase
    .from('generation_batches')
    .select('id, project_id, status')
    .in('status', ['generating', 'halted', 'completed', 'pending']);

  if (projectId) {
    query = query.eq('project_id', projectId);
  }

  const { data: allBatches } = await query;

  // Filter: keep active batches + any batch that has pending/generating/qa jobs
  const activeBatches: typeof allBatches = [];
  for (const batch of allBatches || []) {
    if (batch.status === 'generating' || batch.status === 'halted') {
      activeBatches.push(batch);
      continue;
    }
    // For completed/pending batches, check if they have stuck jobs
    const { count: stuckCount } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch.id)
      .in('status', ['pending', 'generating', 'qa_pending', 'qa_processing']);

    if (stuckCount && stuckCount > 0) {
      activeBatches.push(batch);
    }
  }

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

    // Un-halt batches that have pending jobs but low flagged rate
    if (batchIsHalted) {
      const { data: batchJobs } = await supabase
        .from('generation_jobs')
        .select('status')
        .eq('batch_id', batch.id);

      if (batchJobs) {
        const total = batchJobs.length;
        const flagged = batchJobs.filter((j) => j.status === 'flagged').length;
        const pending = batchJobs.filter((j) => j.status === 'pending').length;
        const flaggedPct = total > 0 ? flagged / total : 0;

        if (pending > 0 && flaggedPct < 0.20) {
          await supabase
            .from('generation_batches')
            .update({ status: 'generating', updated_at: new Date().toISOString() })
            .eq('id', batch.id);
          actions.push(`Un-halted batch (${flagged}/${total} flagged = ${(flaggedPct * 100).toFixed(0)}%, ${pending} pending)`);
          // Update local state so the rest of the checks work
          batch.status = 'generating';
        }
      }
    }

    const batchIsNowHalted = batch.status === 'halted';

    // Check for stale generating jobs. Exclude BRAND_ONLY (owned by regen route, not
    // the batch chain — resetting them causes the batch chain to claim + clobber them).
    const { data: rawStaleGenerating } = await supabase
      .from('generation_jobs')
      .select('id, prompt_adjustment')
      .eq('batch_id', batch.id)
      .eq('status', 'generating')
      .lt('updated_at', staleThreshold);
    const staleGenerating = (rawStaleGenerating || []).filter(
      (j) => j.prompt_adjustment !== 'BRAND_ONLY',
    );

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
    if (!batchIsNowHalted && (staleGenerating?.length || 0) > 0) {
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
    if (!batchIsNowHalted && ((staleGenerating?.length || 0) > 0 || (pendingCount || 0) > 0)) {
      // Re-activate batch if it was completed/pending
      if (batch.status !== 'generating') {
        await supabase
          .from('generation_batches')
          .update({ status: 'generating', updated_at: new Date().toISOString() })
          .eq('id', batch.id);
        actions.push(`Reactivated batch from "${batch.status}" to "generating"`);
      }
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

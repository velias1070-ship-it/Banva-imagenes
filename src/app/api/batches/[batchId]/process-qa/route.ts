import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { scoreImage } from '@/lib/qa-scorer';
import { getCategoryStrategy } from '@/lib/category-strategy';
import { shouldHaltBatch } from '@/lib/qa-criteria';
import { MAX_QA_RETRIES } from '@/lib/constants';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * CADENA 2 — QA CHAIN
 * Process ONE qa_pending job from a batch, then self-invoke for the next.
 * Decoupled from generation chain — runs independently.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  after(async () => {
    try {
      await processOneQAJob(batchId);
    } catch (err) {
      console.error('[process-qa] Error:', err);
    }
  });

  return NextResponse.json({ status: 'qa_processing' });
}

async function processOneQAJob(batchId: string) {
  const supabase = createAdminClient();

  // Get batch info with project
  const { data: batch } = await supabase
    .from('generation_batches')
    .select('*, project:projects(*)')
    .eq('id', batchId)
    .single();

  if (!batch) {
    console.log('[process-qa] Batch not found:', batchId);
    return;
  }

  // Check if batch is halted
  if (batch.status === 'halted') {
    console.log('[process-qa] Batch is halted, stopping QA chain:', batchId);
    return;
  }

  // Get ONE qa_pending job (atomic claim: select then update)
  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (!jobs?.length) {
    // No more qa_pending jobs — check for retry jobs
    console.log('[process-qa] No qa_pending jobs for batch:', batchId);
    await handleQAComplete(batchId, batch);
    return;
  }

  const job = jobs[0];
  const project = batch.project;
  const category = project?.category || 'textile';
  const strategy = getCategoryStrategy(category);

  try {
    // Download 3 images: generated + swatch + hero
    const [generatedRes, swatchRes, heroRes] = await Promise.all([
      supabase.storage.from('images').download(job.output_storage_path),
      supabase.storage.from('images').download(job.swatch.storage_path),
      supabase.storage.from('images').download(job.hero_shot.storage_path),
    ]);

    if (generatedRes.error || swatchRes.error || heroRes.error) {
      throw new Error(
        `Storage download failed: ${generatedRes.error?.message || swatchRes.error?.message || heroRes.error?.message}`
      );
    }

    const generatedBase64 = Buffer.from(await generatedRes.data.arrayBuffer()).toString('base64');
    const swatchBase64 = Buffer.from(await swatchRes.data.arrayBuffer()).toString('base64');
    const heroBase64 = Buffer.from(await heroRes.data.arrayBuffer()).toString('base64');

    // Score the image
    const scoreResult = await scoreImage({
      generatedBase64,
      generatedMimeType: 'image/png',
      swatchBase64,
      swatchMimeType: 'image/png',
      heroBase64,
      heroMimeType: job.hero_shot.mime_type || 'image/png',
      category,
      swatchName: job.swatch.name,
      strategy,
      attempt: job.attempt,
    });

    // Verify job is still qa_pending (might have been regenerated manually)
    const { data: currentJob } = await supabase
      .from('generation_jobs')
      .select('status')
      .eq('id', job.id)
      .single();

    if (currentJob?.status !== 'qa_pending') {
      console.log(`[process-qa] Job ${job.id.substring(0, 8)} status changed to ${currentJob?.status}, skipping QA write`);
      chainNext(batchId);
      return;
    }

    // Determine new status based on QA action
    let newStatus: string;
    switch (scoreResult.action.action) {
      case 'approve':
        newStatus = 'approved';
        break;
      case 'retry':
        newStatus = 'pending'; // Goes back to pending for process-next to pick up
        break;
      case 'flag':
        newStatus = 'flagged';
        break;
    }

    // Update job with QA results
    await supabase
      .from('generation_jobs')
      .update({
        status: newStatus,
        qa_score: scoreResult.score,
        qa_detail: scoreResult.detail,
        qa_feedback: scoreResult.feedback,
        total_api_calls: (job.total_api_calls || 0) + 1,
        prompt_metadata: {
          ...(job.prompt_metadata || {}),
          qa_action: scoreResult.action.action,
          qa_reason: scoreResult.action.reason,
          qa_escalate: scoreResult.action.escalate,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Update batch counters
    const counterUpdates: Record<string, number> = {};
    if (newStatus === 'approved') {
      counterUpdates.approved_count = (batch.approved_count || 0) + 1;
      counterUpdates.completed_count = (batch.completed_count || 0) + 1;
    } else if (newStatus === 'flagged') {
      counterUpdates.flagged_count = (batch.flagged_count || 0) + 1;
      counterUpdates.completed_count = (batch.completed_count || 0) + 1;
    } else if (newStatus === 'pending') {
      counterUpdates.retry_count = (batch.retry_count || 0) + 1;
    }

    if (Object.keys(counterUpdates).length > 0) {
      await supabase
        .from('generation_batches')
        .update(counterUpdates)
        .eq('id', batchId);
    }

    // Check batch halt condition
    if (newStatus === 'flagged') {
      const haltCheck = shouldHaltBatch(
        (batch.flagged_count || 0) + 1,
        (batch.completed_count || 0) + 1
      );

      if (haltCheck.halt) {
        console.log(`[process-qa] HALTING batch ${batchId}: ${haltCheck.reason}`);
        await supabase
          .from('generation_batches')
          .update({ status: 'halted' })
          .eq('id', batchId);
        return; // Stop the chain
      }
    }

    console.log(
      `[process-qa] Job ${job.id.substring(0, 8)} — ` +
      `score: ${(scoreResult.score * 100).toFixed(0)}% → ${newStatus}` +
      `${scoreResult.action.escalate ? ' (ESCALATE)' : ''}`
    );

  } catch (err) {
    // QA failure → leave as qa_pending (NEVER auto-approve on QA error)
    const errorMessage = err instanceof Error ? err.message : 'Unknown QA error';
    console.error(`[process-qa] Job ${job.id.substring(0, 8)} QA error:`, errorMessage);

    // Update total_api_calls even on error
    await supabase
      .from('generation_jobs')
      .update({
        total_api_calls: (job.total_api_calls || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  }

  // Chain: trigger next QA job
  chainNext(batchId);
}

/**
 * Handle QA chain completion — check for retries and finalize batch
 */
async function handleQAComplete(batchId: string, batch: Record<string, unknown>) {
  const supabase = createAdminClient();

  // Check if there are pending jobs (retries from QA)
  const { count: pendingCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .eq('status', 'pending');

  if (pendingCount && pendingCount > 0) {
    // There are retry jobs — invoke process-next to regenerate them
    console.log(`[process-qa] ${pendingCount} pending retries — invoking process-next`);
    const baseUrl = getBaseUrl();
    try {
      await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[process-qa] Failed to invoke process-next for retries:', err);
    }
    return;
  }

  // Check for generating or qa_pending jobs (still in progress)
  const { count: inProgressCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .in('status', ['generating', 'qa_pending']);

  if (inProgressCount && inProgressCount > 0) {
    console.log(`[process-qa] ${inProgressCount} jobs still in progress, not finalizing batch`);
    return;
  }

  // All done — finalize batch
  console.log('[process-qa] All jobs done for batch:', batchId);
  await supabase
    .from('generation_batches')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', batchId);
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

function chainNext(batchId: string) {
  const baseUrl = getBaseUrl();
  const chainUrl = `${baseUrl}/api/batches/${batchId}/process-qa`;
  console.log(`[process-qa] Chaining to: ${chainUrl}`);

  fetch(chainUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => {
    console.error('[process-qa] Failed to chain next QA invocation:', err);
  });
}

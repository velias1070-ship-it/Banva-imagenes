import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { scoreImage } from '@/lib/qa-scorer';
import { getCategoryStrategy } from '@/lib/category-strategy';
import { shouldHaltBatch } from '@/lib/qa-criteria';
import { getProjectSettings } from '@/lib/project-settings';
import { MAX_QA_RETRIES } from '@/lib/constants';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * CADENA 2 — QA CHAIN
 * Process ONE qa_pending job from a batch, then self-invoke for the next.
 * Decoupled from generation chain — runs independently.
 *
 * ARCHITECTURE: Heavy work (QA scoring) runs BEFORE the response.
 * Only lightweight chain continuation (fetch calls) runs in after().
 * This prevents Vercel from killing the after() callback mid-scoring.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  let shouldChain = false;

  try {
    shouldChain = await processOneQAJob(batchId);
  } catch (err) {
    console.error('[process-qa] Error:', err);
    shouldChain = true; // still try next QA job
  }

  // Use after() for fire-and-forget chain continuation
  // CRITICAL: Do NOT await fetch responses — the next invocation takes ~10-20s.
  if (shouldChain) {
    after(async () => {
      const baseUrl = getBaseUrl();
      fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
      // Brief delay to ensure HTTP request is dispatched before cleanup
      await new Promise(r => setTimeout(r, 1500));
    });
  }

  return NextResponse.json({ status: 'qa_processing' });
}

async function processOneQAJob(batchId: string): Promise<boolean> {
  const supabase = createAdminClient();

  // Get batch info with project
  const { data: batch } = await supabase
    .from('generation_batches')
    .select('*, project:projects(*)')
    .eq('id', batchId)
    .single();

  if (!batch) {
    console.log('[process-qa] Batch not found:', batchId);
    return false;
  }

  // Track halted status — QA still evaluates already-generated images,
  // but retries are suppressed (retry → flagged) when batch is halted.
  const batchIsHalted = batch.status === 'halted';
  if (batchIsHalted) {
    console.log('[process-qa] Batch is halted — will evaluate qa_pending but suppress retries');
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
    return false;
  }

  const job = jobs[0];
  const project = batch.project;
  const category = project?.category || 'textile';
  const strategy = getCategoryStrategy(category);
  const projectSettings = getProjectSettings(project?.metadata as Record<string, unknown> | null);

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

    // Score the image (with per-project QA settings)
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
      projectSettings,
    });

    // Verify job is still qa_pending (might have been regenerated manually)
    const { data: currentJob } = await supabase
      .from('generation_jobs')
      .select('status')
      .eq('id', job.id)
      .single();

    if (currentJob?.status !== 'qa_pending') {
      console.log(`[process-qa] Job ${job.id.substring(0, 8)} status changed to ${currentJob?.status}, skipping QA write`);
      return true; // chain to next
    }

    // Determine new status based on QA action
    let newStatus: string;
    switch (scoreResult.action.action) {
      case 'approve':
        newStatus = 'approved';
        break;
      case 'retry':
        // If batch is halted, suppress retries — flag instead of retry
        if (batchIsHalted) {
          newStatus = 'flagged';
          console.log(`[process-qa] Job ${job.id.substring(0, 8)} — retry suppressed (batch halted) → flagged`);
        } else {
          newStatus = 'pending'; // Goes back to pending for process-next to pick up
        }
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

    // Check batch halt condition (only if not already halted)
    if (newStatus === 'flagged' && !batchIsHalted) {
      const haltCheck = shouldHaltBatch(
        (batch.flagged_count || 0) + 1,
        (batch.completed_count || 0) + 1,
        projectSettings
      );

      if (haltCheck.halt) {
        console.log(`[process-qa] HALTING batch ${batchId}: ${haltCheck.reason}`);
        await supabase
          .from('generation_batches')
          .update({ status: 'halted' })
          .eq('id', batchId);
        // NOTE: Do NOT return here — continue QA chain to evaluate remaining
        // qa_pending jobs. They've already been generated, no point wasting them.
        // Retries will be suppressed on next iteration (batchIsHalted check above).
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

    // Update timestamp on error (leave as qa_pending)
    await supabase
      .from('generation_jobs')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', job.id);
  }

  // Signal: chain to next QA job
  return true;
}

/**
 * Handle QA chain completion — check for retries and finalize batch
 */
async function handleQAComplete(batchId: string, batch: Record<string, unknown>) {
  const supabase = createAdminClient();
  const batchIsHalted = (batch as { status?: string }).status === 'halted';

  // Check if there are pending jobs (retries from QA)
  const { count: pendingCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .eq('status', 'pending');

  if (pendingCount && pendingCount > 0) {
    if (batchIsHalted) {
      // Batch is halted — don't invoke retries, just log
      console.log(`[process-qa] ${pendingCount} pending retries but batch is halted — skipping`);
    } else {
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
  if (batchIsHalted) {
    // Batch was halted — keep halted status (user reviews manually)
    console.log('[process-qa] All QA done for halted batch:', batchId);
  } else {
    console.log('[process-qa] All jobs done for batch:', batchId);
    await supabase
      .from('generation_batches')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId);
  }
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

async function chainNext(batchId: string) {
  const baseUrl = getBaseUrl();
  const chainUrl = `${baseUrl}/api/batches/${batchId}/process-qa`;
  console.log(`[process-qa] Chaining to: ${chainUrl}`);

  try {
    await fetch(chainUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[process-qa] Failed to chain next QA invocation:', err);
  }
}

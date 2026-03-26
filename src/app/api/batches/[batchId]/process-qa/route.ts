import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { scoreImage } from '@/lib/qa-scorer';
import { getCategoryStrategy } from '@/lib/category-strategy';
import { shouldHaltBatch } from '@/lib/qa-criteria';
import { getProjectSettings } from '@/lib/project-settings';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * CADENA 2 — QA CHAIN
 * Process ONE qa_pending job from a batch, then self-invoke for the next.
 * Decoupled from generation chain — runs independently.
 *
 * ARCHITECTURE:
 * 1. ATOMIC CLAIM: Update status qa_pending → qa_processing BEFORE scoring.
 *    This prevents concurrent QA chains from processing the same job.
 * 2. Heavy work (QA scoring) runs BEFORE the response.
 * 3. On error → reset to qa_pending (health check also handles stale qa_processing).
 * 4. Counter sync: queries jobs table for counts (no increment race conditions).
 */
/**
 * Reliable chain invocation with retry.
 * Awaits the fetch so we KNOW it was received.
 */
async function reliableQAFetch(url: string, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status < 500) return true;
      console.error(`[process-qa] ${label} returned ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      console.error(`[process-qa] ${label} fetch failed (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
    }
  }
  return false;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  let shouldChain = false;

  try {
    shouldChain = await processOneQAJob(batchId);
  } catch (err) {
    console.error('[process-qa] Error:', err);
    shouldChain = true;
  }

  const baseUrl = getBaseUrl();
  let chainDispatched = false;

  // ── PRIMARY: Awaited fetch with retry ──
  if (shouldChain) {
    chainDispatched = await reliableQAFetch(
      `${baseUrl}/api/batches/${batchId}/process-qa`,
      'qa-chain-next'
    );
  }

  // ── BACKUP: after() only if primary failed ──
  if (shouldChain && !chainDispatched) {
    console.warn(`[process-qa] Primary dispatch failed for batch ${batchId}, using after() backup`);
    after(async () => {
      const backupOk = await reliableQAFetch(
        `${baseUrl}/api/batches/${batchId}/process-qa`,
        'qa-chain-next (after backup)'
      );
      if (!backupOk) {
        console.error(`[process-qa] CRITICAL: Both primary and backup failed for batch ${batchId}. Health check must recover.`);
      }
    });
  }

  if (!shouldChain) {
    console.log(`[process-qa] QA chain stopped for batch ${batchId} — no more qa_pending jobs`);
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

  // ── ATOMIC CLAIM: find qa_pending jobs, then claim one ──
  const { data: candidates } = await supabase
    .from('generation_jobs')
    .select('id')
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .order('created_at', { ascending: true })
    .limit(5);

  if (!candidates?.length) {
    console.log('[process-qa] No qa_pending jobs for batch:', batchId);
    await handleQAComplete(batchId, batch);
    return false;
  }

  // Try to claim one job atomically (optimistic lock)
  let claimedJobId: string | null = null;
  for (const candidate of candidates) {
    const { data: claimed } = await supabase
      .from('generation_jobs')
      .update({
        status: 'qa_processing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', 'qa_pending') // Only claim if still qa_pending
      .select('id')
      .maybeSingle();

    if (claimed) {
      claimedJobId = claimed.id;
      break;
    }
    // Another instance claimed this job — try next candidate
    console.log(`[process-qa] Job ${candidate.id.substring(0, 8)} already claimed — trying next`);
  }

  if (!claimedJobId) {
    // All candidates were claimed by other instances — they're being processed
    console.log('[process-qa] All candidates claimed by other instances');
    // Still chain — there might be more qa_pending jobs arriving
    return true;
  }

  // Fetch full job data (with relations)
  const { data: job } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('id', claimedJobId)
    .single();

  if (!job) {
    console.error(`[process-qa] Failed to fetch claimed job ${claimedJobId}`);
    return true;
  }

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

    // Score the image (with per-project QA settings + swatch hex for color accuracy)
    const scoreResult = await scoreImage({
      generatedBase64,
      generatedMimeType: 'image/png',
      swatchBase64,
      swatchMimeType: 'image/png',
      heroBase64,
      heroMimeType: job.hero_shot.mime_type || 'image/png',
      category,
      swatchName: job.swatch.name,
      swatchHex: job.swatch.dominant_color_hex || null,
      strategy,
      attempt: job.attempt,
      projectSettings,
    });

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

    // Update job with QA results (from qa_processing → final status)
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

    // ── SYNC BATCH COUNTERS from source of truth (prevents race conditions) ──
    await syncBatchCounters(batchId);

    // Check batch halt condition (only if not already halted)
    if (newStatus === 'flagged' && !batchIsHalted) {
      // Re-read batch counters after sync
      const { data: freshBatch } = await supabase
        .from('generation_batches')
        .select('flagged_count, completed_count')
        .eq('id', batchId)
        .single();

      if (freshBatch) {
        const haltCheck = shouldHaltBatch(
          freshBatch.flagged_count || 0,
          freshBatch.completed_count || 0,
          projectSettings
        );

        if (haltCheck.halt) {
          console.log(`[process-qa] HALTING batch ${batchId}: ${haltCheck.reason}`);
          await supabase
            .from('generation_batches')
            .update({ status: 'halted' })
            .eq('id', batchId);
        }
      }
    }

    console.log(
      `[process-qa] Job ${job.id.substring(0, 8)} — ` +
      `score: ${(scoreResult.score * 100).toFixed(0)}% → ${newStatus}` +
      `${scoreResult.action.escalate ? ' (ESCALATE)' : ''}`
    );

  } catch (err) {
    // QA failure → reset to qa_pending (another chain attempt or health check will retry)
    const errorMessage = err instanceof Error ? err.message : 'Unknown QA error';
    console.error(`[process-qa] Job ${job.id.substring(0, 8)} QA error:`, errorMessage);

    await supabase
      .from('generation_jobs')
      .update({
        status: 'qa_pending', // Reset — NOT qa_processing (allow retry)
        error_message: `QA error: ${errorMessage}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  }

  // Signal: chain to next QA job
  return true;
}

/**
 * Sync batch counters from the jobs table (source of truth).
 * This prevents race conditions from concurrent counter increments.
 */
async function syncBatchCounters(batchId: string) {
  const supabase = createAdminClient();

  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select('status')
    .eq('batch_id', batchId);

  if (!jobs) return;

  const counts = {
    approved_count: 0,
    flagged_count: 0,
    error_count: 0,
    retry_count: 0,
    completed_count: 0,
  };

  for (const job of jobs) {
    switch (job.status) {
      case 'approved':
        counts.approved_count++;
        counts.completed_count++;
        break;
      case 'flagged':
        counts.flagged_count++;
        counts.completed_count++;
        break;
      case 'error':
        counts.error_count++;
        counts.completed_count++;
        break;
    }
  }

  // Count retries: jobs with attempt > 1 that went back to pending
  const { count: retryCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .gt('attempt', 1);

  counts.retry_count = retryCount || 0;

  await supabase
    .from('generation_batches')
    .update(counts)
    .eq('id', batchId);
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
      console.log(`[process-qa] ${pendingCount} pending retries but batch is halted — skipping`);
    } else {
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

  // Check for in-flight jobs (generating, qa_pending, OR qa_processing)
  const { count: inProgressCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .in('status', ['generating', 'qa_pending', 'qa_processing']);

  if (inProgressCount && inProgressCount > 0) {
    console.log(`[process-qa] ${inProgressCount} jobs still in progress, not finalizing batch`);
    return;
  }

  // All done — sync counters and finalize batch
  await syncBatchCounters(batchId);

  if (batchIsHalted) {
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

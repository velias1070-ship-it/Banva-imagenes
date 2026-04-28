import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logPipelineEvent } from '@/lib/pipeline-log';

export const maxDuration = 60;

/**
 * Sprint 2 issue #1 — promotes qa_rate_limited jobs back to qa_pending when
 * their next_retry_at has elapsed, and (bonus pass) marks orphaned qa_pending
 * jobs (>1h since last update) as terminal error.
 *
 * Triggered by Vercel cron every 10 min (vercel.json). Authorized via
 * CRON_SECRET when present. Idempotent: optimistic UPDATEs filter on the
 * pre-transition status so concurrent invocations cannot double-promote.
 */

const STALE_QA_PENDING_HOURS = 1;
const PROMOTE_BATCH_SIZE = 100;
const CLEANUP_BATCH_SIZE = 100;

function getBaseUrl(): string | null {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
}

export async function GET(request: NextRequest) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>. We only enforce
  // when the secret is set — local dev / first deploy can run without it.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const staleQaPendingThreshold = new Date(Date.now() - STALE_QA_PENDING_HOURS * 3_600_000).toISOString();

  // ── 1. Promote qa_rate_limited jobs whose next_retry_at has elapsed ──
  const { data: ready } = await supabase
    .from('generation_jobs')
    .select('id, batch_id')
    .eq('status', 'qa_rate_limited')
    .lt('next_retry_at', now)
    .limit(PROMOTE_BATCH_SIZE);

  const promoted: { id: string; batch_id: string }[] = [];
  for (const job of ready || []) {
    // Optimistic update: only flips if the row is still qa_rate_limited
    const { data: updated } = await supabase
      .from('generation_jobs')
      .update({ status: 'qa_pending', next_retry_at: null, updated_at: now })
      .eq('id', job.id)
      .eq('status', 'qa_rate_limited')
      .select('id')
      .maybeSingle();
    if (updated) {
      logPipelineEvent(job.id, 'RATE_LIMIT_PROMOTED', 'cron woke job for QA retry');
      promoted.push({ id: job.id, batch_id: job.batch_id });
    }
  }

  // ── 2. Bonus pass: clean orphaned qa_pending (>1h sin movimiento) ──
  // These accumulate from abandoned batches (failed deploys, killed Vercel
  // invocations, etc.). Marking as error makes them visible without polluting
  // the live queue.
  const { data: orphans } = await supabase
    .from('generation_jobs')
    .select('id, updated_at')
    .eq('status', 'qa_pending')
    .lt('updated_at', staleQaPendingThreshold)
    .limit(CLEANUP_BATCH_SIZE);

  const cleaned: string[] = [];
  for (const job of orphans || []) {
    const { data: updated } = await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: `Cleanup: orphaned in qa_pending >${STALE_QA_PENDING_HOURS}h. Likely abandoned by failed deploy chain or pre-Sprint-2 retry-on-429 loop.`,
        updated_at: now,
      })
      .eq('id', job.id)
      .eq('status', 'qa_pending')
      .select('id')
      .maybeSingle();
    if (updated) {
      logPipelineEvent(job.id, 'ZOMBIE_CLEANED', `stale qa_pending >${STALE_QA_PENDING_HOURS}h`);
      cleaned.push(job.id);
    }
  }

  // ── 3. Kick QA chain for each unique batch that received promotions ──
  // Without this, the promoted rows wait until the next process-next /
  // health invocation. Fire-and-forget so the cron stays fast.
  const baseUrl = getBaseUrl();
  const uniqueBatches = Array.from(new Set(promoted.map(p => p.batch_id)));
  if (baseUrl && uniqueBatches.length > 0) {
    for (const batchId of uniqueBatches) {
      fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    }
  }

  return NextResponse.json({
    promoted: promoted.length,
    cleaned: cleaned.length,
    chains_kicked: uniqueBatches.length,
    checked_at: now,
  });
}

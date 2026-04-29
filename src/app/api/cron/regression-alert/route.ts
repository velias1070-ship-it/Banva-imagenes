import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { detectRegression, type JobOutcome } from '@/lib/regression-detector';

export const maxDuration = 60;

/**
 * Sprint 2 issue #5 — fires every 15 minutes (vercel.json). For each
 * (model_id, case_signature) bucket with >= MIN_TOTAL recent terminal
 * jobs, splits the rolling window into older half (baseline) vs newer
 * half (rolling) and alerts when approval rate dropped >= DROP_PP_THRESHOLD.
 *
 * The window is per-bucket, not global — a (model, case) bucket gets
 * 50 jobs of history. Total query is bounded by selecting the most
 * recent N jobs per (model_id, case_signature) via PostgREST.
 *
 * Notification:
 *   - If env VIKI_WEBHOOK_URL + VIKI_SECRET are set, POST a JSON
 *     payload there with the regressions array.
 *   - Otherwise (Viki webhook not yet wired), log warning + skip.
 *     This is the stub described in the Sprint 2 issue #5 spec.
 *
 * Authorized via CRON_SECRET when set (existing one from Sprint 2 issue #1).
 */

const WINDOW_PER_BUCKET = 100; // 50 older + 50 newer halves
const MIN_TOTAL = 20;          // need at least this many to call it a window
const DROP_PP_THRESHOLD = 0.15;
const MIN_BASELINE = 0.50;

type JobRow = {
  model_id: string;
  case_signature: string;
  status: string;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createAdminClient();

  // Pull the recent terminal jobs that have telemetry. We then group in
  // memory by (model_id, case_signature). 5000-row cap is plenty for a
  // 15-min cadence and ~50 buckets max active at any time.
  const { data: rows, error } = await supabase
    .from('generation_jobs')
    .select('model_id, case_signature, status, created_at')
    .eq('_telemetry_source', 'sprint_1_runtime')
    .not('case_signature', 'is', null)
    .not('model_id', 'is', null)
    .in('status', ['approved', 'flagged', 'error'])
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Group into per-(model, case) buckets. We then keep only the most
  // recent WINDOW_PER_BUCKET jobs per bucket — already sorted desc.
  const buckets = new Map<string, JobOutcome[]>();
  for (const r of (rows || []) as JobRow[]) {
    const key = `${r.model_id}|${r.case_signature}`;
    const arr = buckets.get(key) ?? [];
    if (arr.length < WINDOW_PER_BUCKET) {
      arr.push({ status: r.status, created_at: r.created_at });
      buckets.set(key, arr);
    }
  }

  const regressions: Array<{
    model_id: string;
    case_signature: string;
    total: number;
    baseline_pct: number;
    rolling_pct: number;
    drop_pp: number;
  }> = [];
  const checked: number[] = [];

  for (const [key, jobs] of buckets) {
    if (jobs.length < MIN_TOTAL) continue;
    const [modelId, caseSignature] = key.split('|');
    const result = detectRegression({
      modelId,
      caseSignature,
      jobs,
      dropPpThreshold: DROP_PP_THRESHOLD,
      minBaseline: MIN_BASELINE,
    });
    checked.push(jobs.length);
    if (result.isRegression) {
      regressions.push({
        model_id: modelId,
        case_signature: caseSignature,
        total: result.total,
        baseline_pct: Math.round((result.baselineApprovalRate ?? 0) * 1000) / 10,
        rolling_pct: Math.round((result.rollingApprovalRate ?? 0) * 1000) / 10,
        drop_pp: Math.round((result.dropPp ?? 0) * 1000) / 10,
      });
    }
  }

  // Notify Viki webhook — guarded so the cron stays useful while we wait
  // for Viki to send us the URL.
  let notified = false;
  let notifyError: string | null = null;
  const vikiUrl = process.env.VIKI_WEBHOOK_URL;
  const vikiSecret = process.env.VIKI_SECRET;
  if (regressions.length > 0) {
    if (vikiUrl && vikiSecret) {
      try {
        const res = await fetch(vikiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${vikiSecret}`,
            'X-Source': 'banva-app/regression-alert',
          },
          body: JSON.stringify({
            kind: 'banva_regression_alert',
            detected_at: new Date().toISOString(),
            window: { per_bucket: WINDOW_PER_BUCKET, drop_pp_threshold: DROP_PP_THRESHOLD, min_baseline: MIN_BASELINE },
            regressions,
          }),
        });
        notified = res.ok;
        if (!res.ok) notifyError = `webhook ${res.status}`;
      } catch (err) {
        notifyError = err instanceof Error ? err.message : 'unknown';
      }
    } else {
      console.warn(
        `[regression-alert] ${regressions.length} regression(s) detected but VIKI_WEBHOOK_URL/VIKI_SECRET are not set. Skipping notification.`,
        regressions,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    checked_at: new Date().toISOString(),
    buckets_total: buckets.size,
    buckets_checked: checked.length,
    regressions_count: regressions.length,
    regressions,
    notification: {
      configured: !!(vikiUrl && vikiSecret),
      sent: notified,
      error: notifyError,
    },
  });
}

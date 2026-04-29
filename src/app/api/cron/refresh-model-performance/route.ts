import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

/**
 * Sprint 2 issue #4 — daily REFRESH of the model_performance materialized
 * view. Vercel cron fires this at 00:00 UTC (vercel.json). Authorized via
 * CRON_SECRET when present.
 *
 * The actual REFRESH is wrapped in a Postgres function because the JS
 * client doesn't expose raw DDL, and writing a per-app exec_sql would be
 * a much wider security surface than a single-purpose function.
 *
 * REFRESH ... CONCURRENTLY requires a UNIQUE INDEX on the MV (created in
 * migration 010 as idx_model_performance_pk). Concurrent refresh keeps
 * reads non-blocking — important because Sprint 2 issue #5's regression
 * alert query reads from this view.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createAdminClient();
  const startedAt = Date.now();

  // Resilience: if migration 010 hasn't been applied yet, the function
  // does not exist. Surface the error JSON-style so the caller can tell
  // (and the cron schedule keeps trying without crashing).
  const { error } = await supabase.rpc('refresh_model_performance');

  const durationMs = Date.now() - startedAt;

  if (error) {
    return NextResponse.json({
      ok: false,
      error: error.message,
      hint: error.message.includes('does not exist')
        ? 'Apply supabase/migrations/010_model_performance.sql via Dashboard.'
        : null,
      duration_ms: durationMs,
    }, { status: 500 });
  }

  // Pull a quick row count so the cron output tells us whether the MV
  // grew since the last refresh.
  const { count } = await supabase
    .from('model_performance')
    .select('*', { count: 'exact', head: true });

  return NextResponse.json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    row_count: count ?? null,
    duration_ms: durationMs,
  });
}

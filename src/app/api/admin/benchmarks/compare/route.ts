/**
 * POST /api/admin/benchmarks/compare
 * Body: { base: string, against: string, persist?: boolean }
 * Returns { markdown, recommendation }.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { compareRuns, renderMarkdown, type GoldenRow } from '@/lib/golden-comparator';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AdminAuthError) return NextResponse.json({ error: err.reason }, { status: 401 });
    throw err;
  }

  const body = await req.json().catch(() => null);
  if (!body?.base || !body?.against) {
    return NextResponse.json({ error: 'invalid body — expected { base, against }' }, { status: 400 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const SELECT = 'run_id, case_id, model_id_tested, score_total, cost_usd, duration_ms, run_metadata';
  const [baseRes, againstRes] = await Promise.all([
    supabase.from('golden_runs').select(SELECT).eq('run_id', body.base),
    supabase.from('golden_runs').select(SELECT).eq('run_id', body.against),
  ]);
  if (baseRes.error || againstRes.error) {
    return NextResponse.json({ error: baseRes.error?.message || againstRes.error?.message }, { status: 500 });
  }
  if (!baseRes.data?.length) return NextResponse.json({ error: `base run_id not found` }, { status: 404 });
  if (!againstRes.data?.length) return NextResponse.json({ error: `against run_id not found` }, { status: 404 });

  const result = compareRuns(baseRes.data as GoldenRow[], againstRes.data as GoldenRow[]);
  const markdown = renderMarkdown(result, body.base, body.against);

  if (body.persist) {
    const followupRunId = crypto.randomUUID();
    await supabase.from('golden_runs').insert({
      run_id: followupRunId,
      suite_name: 'comparison-followup',
      case_id: `compare-${body.base.substring(0, 8)}-vs-${body.against.substring(0, 8)}`,
      model_id_tested: result.against_model || 'unknown',
      compared_to_run_id: body.base,
      score_total: null,
      run_metadata: {
        recommendation: result.recommendation,
        reason: result.recommendation_reason,
        regressions: result.regressions.length,
        improvements: result.improvements.length,
        parity: result.parity.length,
        missing: result.missing.length,
        cost_delta_usd: result.totals.cost_delta_usd,
        comparison_target_run_id: body.against,
      },
    });
  }

  return NextResponse.json({ markdown, recommendation: result.recommendation });
}

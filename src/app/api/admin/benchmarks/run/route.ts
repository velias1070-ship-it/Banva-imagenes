/**
 * POST /api/admin/benchmarks/run
 * Body: { suite: string, model: string }
 * Returns runId immediately and runs the suite in the background via after().
 * The UI redirects to /admin/benchmarks/{runId}; rows appear there as each
 * case completes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runSuiteAgainstModel } from '@/lib/golden-runner';
import { MODEL_REGISTRY } from '@/lib/models/registry';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';
import type { ProviderId } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AdminAuthError) return NextResponse.json({ error: err.reason }, { status: 401 });
    throw err;
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.suite !== 'string' || typeof body.model !== 'string') {
    return NextResponse.json({ error: 'invalid body — expected { suite, model }' }, { status: 400 });
  }
  if (!MODEL_REGISTRY[body.model]) {
    return NextResponse.json({ error: `unknown model: ${body.model}` }, { status: 400 });
  }

  const runId = crypto.randomUUID();

  after(async () => {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    try {
      await runSuiteAgainstModel({ supabase, suiteName: body.suite, modelId: body.model as ProviderId, runId });
    } catch (err) {
      console.error('[golden-run]', err);
      await supabase.from('golden_runs').insert({
        run_id: runId,
        suite_name: body.suite,
        case_id: '__error__',
        model_id_tested: body.model,
        score_total: null,
        cost_usd: 0,
        duration_ms: 0,
        run_metadata: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  return NextResponse.json({ runId });
}

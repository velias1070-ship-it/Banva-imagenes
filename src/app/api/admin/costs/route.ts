/**
 * GET /api/admin/costs
 * Aggregated cost telemetry from generation_jobs.cost_usd_actual.
 *
 * Returns: time-window summaries, per-project, per-model, per-status,
 * recent jobs, "wasted" cost (stuck jobs that consumed API but didn't
 * produce a usable image), and pipeline health snapshot.
 *
 * Auth: requireAdmin().
 */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USD_TO_CLP = 950;

type Row = {
  id: string;
  status: string;
  attempt: number | null;
  cost_usd_actual: number | null;
  provider_used: string | null;
  model_id: string | null;
  gemini_model_used: string | null;
  updated_at: string;
  created_at: string;
  batch_id: string;
  swatch: { name: string | null } | null;
  hero_shot: { shot_type: string | null } | null;
  batch: { project: { id: string; name: string | null } | null } | null;
};

function bucket(status: string): 'approved' | 'stuck' | 'flagged' | 'error' | 'in_progress' {
  if (status === 'approved') return 'approved';
  if (status === 'flagged') return 'flagged';
  if (status === 'error') return 'error';
  if (status === 'qa_rate_limited' || status === 'qa_pending' || status === 'qa_processing') return 'stuck';
  return 'in_progress';
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AdminAuthError) return NextResponse.json({ error: err.reason }, { status: 401 });
    throw err;
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Pull last 30 days of cost-bearing jobs in one shot.
  const since30 = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data, error } = await supabase
    .from('generation_jobs')
    .select(`
      id, status, attempt, cost_usd_actual, provider_used, model_id, gemini_model_used,
      updated_at, created_at, batch_id,
      swatch:swatches(name),
      hero_shot:hero_shots(shot_type),
      batch:generation_batches(project:projects(id, name))
    `)
    .gte('updated_at', since30)
    .order('updated_at', { ascending: false })
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []) as unknown as Row[];

  const now = Date.now();
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 3600_000);
  const last7 = now - 7 * 24 * 3600_000;
  const last30 = now - 30 * 24 * 3600_000;
  const lastHour = now - 3600_000;
  const last24h = now - 24 * 3600_000;

  const sumWindow = (filterFn: (r: Row) => boolean) => {
    let usd = 0; let jobs = 0; let approved = 0;
    for (const r of rows) {
      if (!filterFn(r)) continue;
      jobs++;
      usd += Number(r.cost_usd_actual || 0);
      if (r.status === 'approved') approved++;
    }
    return { jobs, usd: round(usd), clp: Math.round(usd * USD_TO_CLP), approved };
  };

  const summary = {
    today: sumWindow(r => new Date(r.updated_at).getTime() >= todayStart.getTime()),
    yesterday: sumWindow(r => {
      const t = new Date(r.updated_at).getTime();
      return t >= yesterdayStart.getTime() && t < todayStart.getTime();
    }),
    last_7d: sumWindow(r => new Date(r.updated_at).getTime() >= last7),
    last_30d: sumWindow(() => true),
  };

  // Per-project (last 30 days)
  const projectMap = new Map<string, { project_id: string; name: string; jobs: number; usd: number; approved: number; stuck: number; flagged: number; error: number }>();
  for (const r of rows) {
    const projectId = r.batch?.project?.id || 'sin_proyecto';
    const projectName = r.batch?.project?.name || 'Sin proyecto';
    let p = projectMap.get(projectId);
    if (!p) {
      p = { project_id: projectId, name: projectName, jobs: 0, usd: 0, approved: 0, stuck: 0, flagged: 0, error: 0 };
      projectMap.set(projectId, p);
    }
    p.jobs++;
    p.usd += Number(r.cost_usd_actual || 0);
    const b = bucket(r.status);
    if (b === 'approved') p.approved++;
    else if (b === 'stuck') p.stuck++;
    else if (b === 'flagged') p.flagged++;
    else if (b === 'error') p.error++;
  }
  const by_project = Array.from(projectMap.values())
    .map(p => ({ ...p, usd: round(p.usd), clp: Math.round(p.usd * USD_TO_CLP) }))
    .sort((a, b) => b.usd - a.usd);

  // Per-model (last 30 days)
  const modelMap = new Map<string, { model: string; jobs: number; usd: number; approved: number }>();
  for (const r of rows) {
    const m = r.gemini_model_used || r.model_id || r.provider_used || 'unknown';
    let mm = modelMap.get(m);
    if (!mm) { mm = { model: m, jobs: 0, usd: 0, approved: 0 }; modelMap.set(m, mm); }
    mm.jobs++;
    mm.usd += Number(r.cost_usd_actual || 0);
    if (r.status === 'approved') mm.approved++;
  }
  const by_model = Array.from(modelMap.values())
    .map(m => ({ ...m, usd: round(m.usd), avg_per_job: m.jobs > 0 ? round(m.usd / m.jobs) : 0 }))
    .sort((a, b) => b.usd - a.usd);

  // Per-status (last 30 days)
  const statusMap = new Map<string, { status: string; jobs: number; usd: number }>();
  for (const r of rows) {
    let s = statusMap.get(r.status);
    if (!s) { s = { status: r.status, jobs: 0, usd: 0 }; statusMap.set(r.status, s); }
    s.jobs++;
    s.usd += Number(r.cost_usd_actual || 0);
  }
  const by_status = Array.from(statusMap.values())
    .map(s => ({ ...s, usd: round(s.usd) }))
    .sort((a, b) => b.jobs - a.jobs);

  // Wasted: jobs that consumed API but are stuck without producing a usable image.
  // qa_rate_limited / qa_pending / qa_processing all already paid the generation cost.
  let wastedUsd = 0; let wastedJobs = 0;
  for (const r of rows) {
    if (bucket(r.status) === 'stuck') {
      wastedJobs++;
      wastedUsd += Number(r.cost_usd_actual || 0);
    }
  }
  const wasted = { jobs: wastedJobs, usd: round(wastedUsd), clp: Math.round(wastedUsd * USD_TO_CLP) };

  // Health snapshot
  let lastApprovedAt: string | null = null;
  let lastGenAt: string | null = null;
  let rateLimited1h = 0;
  let approved24h = 0; let totalQa24h = 0;
  for (const r of rows) {
    const t = new Date(r.updated_at).getTime();
    if (t >= last24h) {
      if (r.status === 'approved') approved24h++;
      if (['approved', 'flagged'].includes(r.status)) totalQa24h++;
    }
    if (t >= lastHour && r.status === 'qa_rate_limited') rateLimited1h++;
    if (r.status === 'approved' && (!lastApprovedAt || r.updated_at > lastApprovedAt)) {
      lastApprovedAt = r.updated_at;
    }
    if (Number(r.cost_usd_actual || 0) > 0 && (!lastGenAt || r.updated_at > lastGenAt)) {
      lastGenAt = r.updated_at;
    }
  }
  const health = {
    last_approved_at: lastApprovedAt,
    last_generation_at: lastGenAt,
    rate_limited_last_hour: rateLimited1h,
    approval_rate_24h: totalQa24h > 0 ? round(approved24h / totalQa24h) : null,
  };

  // Recent jobs (last 40)
  const recent = rows.slice(0, 40).map(r => ({
    id: r.id,
    project: r.batch?.project?.name || 'Sin proyecto',
    swatch: r.swatch?.name || null,
    shot_type: r.hero_shot?.shot_type || null,
    status: r.status,
    attempt: r.attempt,
    cost_usd: Number(r.cost_usd_actual || 0),
    model: r.gemini_model_used || r.model_id || r.provider_used || null,
    updated_at: r.updated_at,
  }));

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    summary,
    by_project,
    by_model,
    by_status,
    wasted,
    health,
    recent,
  });
}

function round(n: number) { return Math.round(n * 10000) / 10000; }

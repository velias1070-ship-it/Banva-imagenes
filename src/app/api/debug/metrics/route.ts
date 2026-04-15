import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

/**
 * Pipeline metrics endpoint — aggregate stats for approval rates, retries,
 * cost, Delta-E distribution, etc. Feeds the "where is the money going"
 * question and enables data-driven decisions about threshold tuning and
 * category-specific prompt improvements.
 *
 * Audit reference: H4 from audits/2026-04-14-audit-v2.md — research
 * (research/2026-04-14-...:169) recommends tracking "costo por imagen,
 * LPIPS, CLIPScore, modelo, prompt template" as essential telemetry for
 * small teams.
 *
 * GET /api/debug/metrics
 *
 * Query params (all optional):
 *   since   — ISO date, default = 7 days ago
 *   until   — ISO date, default = now
 *   project — exact project UUID (restricts to one project)
 *
 * Response:
 *   {
 *     range: { since, until, total_jobs },
 *     global: { approval_rate, flag_rate, avg_attempts, est_cost_usd, avg_delta_e },
 *     by_category: [{ category, total, approved, flagged, approval_rate, avg_attempts, est_cost_usd, avg_delta_e, p90_delta_e }],
 *     by_model: [{ model, total, approved, flagged, approval_rate, avg_attempts, est_cost_usd }],
 *     by_status: { approved, flagged, generating, qa_pending, ... },
 *     retry_distribution: { "0": N, "1": N, "2": N, ... },
 *     top_expensive_jobs: [{ id, attempts, est_cost_usd, category, status }]
 *   }
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const qp = url.searchParams;
  const supabase = createAdminClient();

  const since = qp.get('since') || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const until = qp.get('until') || new Date().toISOString();
  const projectId = qp.get('project') || null;

  // Fetch rows. We join to batches/projects/swatches so we have category and model
  // in one pass. No post-join filters — the range filter applies in SQL.
  let query = supabase
    .from('generation_jobs')
    .select(`
      id,
      status,
      attempt,
      qa_score,
      gemini_model_used,
      prompt_metadata,
      updated_at,
      batch:generation_batches(project_id, project:projects(name, category))
    `)
    .gte('updated_at', since)
    .lte('updated_at', until);

  if (projectId) {
    // Need !inner so we can filter on the join
    query = supabase
      .from('generation_jobs')
      .select(`
        id,
        status,
        attempt,
        qa_score,
        gemini_model_used,
        prompt_metadata,
        updated_at,
        batch:generation_batches!inner(project_id, project:projects!inner(name, category))
      `)
      .gte('updated_at', since)
      .lte('updated_at', until)
      .eq('batch.project_id', projectId);
  }

  // Pull up to 5000 rows (the metrics window is capped at 7 days of typical throughput)
  const { data, error } = await query.limit(5000);
  if (error) {
    return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    status: string;
    attempt: number;
    qa_score: number | null;
    gemini_model_used: string | null;
    prompt_metadata: Record<string, unknown> | null;
    updated_at: string;
    batch: { project_id?: string; project?: { name?: string; category?: string } } | null;
  };

  const rows = (data || []) as unknown as Row[];
  const totalJobs = rows.length;

  // Cost estimates (per gemini-api.md docs):
  //   Flash generation + verifier + QA "happy path"  ~= $0.15
  //   Pro generation  + verifier                     ~= $0.22
  //   Each retry adds ~ Pro ($0.12) + verifier ($0.10) = $0.22
  //   BRAND_ONLY regen adds ~$0.24
  // We approximate per-job cost by: base cost for first attempt + retry cost per extra attempt.
  const estimateCost = (r: Row): number => {
    const isPro = (r.gemini_model_used || '').toLowerCase().includes('pro');
    const baseAttempt = isPro ? 0.22 : 0.15;
    const retryAttempts = Math.max(0, (r.attempt || 0) - 1);
    return baseAttempt + retryAttempts * 0.22;
  };

  // ── Global stats ──
  const approved = rows.filter(r => r.status === 'approved').length;
  const flagged = rows.filter(r => r.status === 'flagged').length;
  const pending = rows.filter(r => r.status === 'pending' || r.status === 'generating' || r.status === 'qa_pending').length;
  const errored = rows.filter(r => r.status === 'error').length;

  const deltaEs = rows
    .map(r => {
      const v = r.prompt_metadata?.color_delta_e;
      return typeof v === 'number' ? v : null;
    })
    .filter((v): v is number => v !== null);
  const avgDeltaE = deltaEs.length > 0 ? deltaEs.reduce((s, v) => s + v, 0) / deltaEs.length : null;
  const p90DeltaE = (() => {
    if (deltaEs.length === 0) return null;
    const sorted = [...deltaEs].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.9);
    return sorted[Math.min(idx, sorted.length - 1)];
  })();

  const totalCostEst = rows.reduce((s, r) => s + estimateCost(r), 0);
  const avgAttempts = totalJobs > 0 ? rows.reduce((s, r) => s + (r.attempt || 0), 0) / totalJobs : 0;

  // ── By category ──
  const categoryMap: Record<string, Row[]> = {};
  for (const r of rows) {
    const cat = r.batch?.project?.category || '_unknown';
    (categoryMap[cat] = categoryMap[cat] || []).push(r);
  }
  const byCategory = Object.entries(categoryMap).map(([cat, crows]) => {
    const approvedC = crows.filter(r => r.status === 'approved').length;
    const flaggedC = crows.filter(r => r.status === 'flagged').length;
    const deltaEsC = crows
      .map(r => {
        const v = r.prompt_metadata?.color_delta_e;
        return typeof v === 'number' ? v : null;
      })
      .filter((v): v is number => v !== null);
    const avgDeltaEC = deltaEsC.length > 0 ? deltaEsC.reduce((s, v) => s + v, 0) / deltaEsC.length : null;
    const p90DeltaEC = (() => {
      if (deltaEsC.length === 0) return null;
      const sorted = [...deltaEsC].sort((a, b) => a - b);
      const idx = Math.floor(sorted.length * 0.9);
      return sorted[Math.min(idx, sorted.length - 1)];
    })();
    return {
      category: cat,
      total: crows.length,
      approved: approvedC,
      flagged: flaggedC,
      approval_rate: crows.length > 0 ? approvedC / crows.length : 0,
      avg_attempts: crows.length > 0 ? crows.reduce((s, r) => s + (r.attempt || 0), 0) / crows.length : 0,
      est_cost_usd: crows.reduce((s, r) => s + estimateCost(r), 0),
      avg_delta_e: avgDeltaEC,
      p90_delta_e: p90DeltaEC,
    };
  }).sort((a, b) => b.total - a.total);

  // ── By model ──
  const modelMap: Record<string, Row[]> = {};
  for (const r of rows) {
    const m = r.gemini_model_used || '_unknown';
    (modelMap[m] = modelMap[m] || []).push(r);
  }
  const byModel = Object.entries(modelMap).map(([model, mrows]) => {
    const approvedM = mrows.filter(r => r.status === 'approved').length;
    const flaggedM = mrows.filter(r => r.status === 'flagged').length;
    return {
      model,
      total: mrows.length,
      approved: approvedM,
      flagged: flaggedM,
      approval_rate: mrows.length > 0 ? approvedM / mrows.length : 0,
      avg_attempts: mrows.length > 0 ? mrows.reduce((s, r) => s + (r.attempt || 0), 0) / mrows.length : 0,
      est_cost_usd: mrows.reduce((s, r) => s + estimateCost(r), 0),
    };
  }).sort((a, b) => b.total - a.total);

  // ── By status (full breakdown) ──
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  // ── Retry distribution ──
  const retryDistribution: Record<string, number> = {};
  for (const r of rows) {
    const a = String(r.attempt || 0);
    retryDistribution[a] = (retryDistribution[a] || 0) + 1;
  }

  // ── Top 5 most expensive jobs ──
  const costed = rows.map(r => ({
    id: r.id,
    attempts: r.attempt,
    est_cost_usd: estimateCost(r),
    category: r.batch?.project?.category || null,
    project: r.batch?.project?.name || null,
    status: r.status,
    debug_url: `/api/debug/jobs/${r.id}`,
  }));
  const topExpensive = [...costed].sort((a, b) => b.est_cost_usd - a.est_cost_usd).slice(0, 5);

  return NextResponse.json({
    range: {
      since,
      until,
      total_jobs: totalJobs,
      project_id: projectId,
    },
    global: {
      approved,
      flagged,
      pending,
      errored,
      approval_rate: totalJobs > 0 ? approved / totalJobs : 0,
      flag_rate: totalJobs > 0 ? flagged / totalJobs : 0,
      avg_attempts: Number(avgAttempts.toFixed(2)),
      est_cost_usd: Number(totalCostEst.toFixed(2)),
      avg_cost_per_approved: approved > 0 ? Number((totalCostEst / approved).toFixed(3)) : null,
      avg_delta_e: avgDeltaE !== null ? Number(avgDeltaE.toFixed(2)) : null,
      p90_delta_e: p90DeltaE !== null ? Number(p90DeltaE.toFixed(2)) : null,
      delta_e_samples: deltaEs.length,
    },
    by_category: byCategory.map(c => ({
      ...c,
      approval_rate: Number(c.approval_rate.toFixed(3)),
      avg_attempts: Number(c.avg_attempts.toFixed(2)),
      est_cost_usd: Number(c.est_cost_usd.toFixed(2)),
      avg_delta_e: c.avg_delta_e !== null ? Number(c.avg_delta_e.toFixed(2)) : null,
      p90_delta_e: c.p90_delta_e !== null ? Number(c.p90_delta_e.toFixed(2)) : null,
    })),
    by_model: byModel.map(m => ({
      ...m,
      approval_rate: Number(m.approval_rate.toFixed(3)),
      avg_attempts: Number(m.avg_attempts.toFixed(2)),
      est_cost_usd: Number(m.est_cost_usd.toFixed(2)),
    })),
    by_status: byStatus,
    retry_distribution: retryDistribution,
    top_expensive_jobs: topExpensive.map(j => ({
      ...j,
      est_cost_usd: Number(j.est_cost_usd.toFixed(2)),
    })),
  });
}

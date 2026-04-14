import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

/**
 * Job finder / filter endpoint — query generation_jobs by any combination of
 * fields. Used from the Claude Code chat to locate jobs without remembering
 * UUIDs when multiple projects exist.
 *
 * GET /api/debug/search-jobs
 *
 * Query params (all optional):
 *   project_id    — exact project UUID
 *   project_name  — ilike match on projects.name (case-insensitive, partial)
 *   category      — exact category string (quilts, sabanas, toallas, ...)
 *   status        — exact (pending, generating, qa_pending, approved, flagged, error)
 *   swatch_name   — ilike match on swatches.name (e.g. "canela")
 *   shot_type     — exact detected_shot_type (main, lifestyle, detail, doblada, infografia, flatlay)
 *   brand_only    — boolean: only jobs in prompt_adjustment=BRAND_ONLY
 *   model         — ilike match on gemini_model_used (e.g. "pro", "flash")
 *   min_attempt   — integer, jobs with attempt >= N
 *   max_attempt   — integer, jobs with attempt <= N
 *   min_score     — float 0..1, qa_score >= N
 *   max_score     — float 0..1, qa_score <= N
 *   since         — ISO date, updated_at >= since
 *   until         — ISO date, updated_at <= until
 *   text          — free text: matches swatch name OR project name OR job id prefix
 *   limit         — max rows (default 25, max 200)
 *   order         — "updated_desc" (default) | "updated_asc" | "score_desc" | "score_asc" | "attempt_desc"
 *
 * Response:
 *   {
 *     total: number,          // rows returned (<= limit)
 *     filters: {...},          // the filters that were applied (for debugging)
 *     jobs: [ { ...slim job... } ]
 *   }
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const qp = url.searchParams;
  const supabase = createAdminClient();

  const limit = Math.min(Math.max(parseInt(qp.get('limit') || '25', 10), 1), 200);
  const order = qp.get('order') || 'updated_desc';

  // Start from generation_jobs with joined metadata
  let query = supabase
    .from('generation_jobs')
    .select(`
      id,
      batch_id,
      status,
      attempt,
      qa_score,
      gemini_model_used,
      output_storage_path,
      prompt_adjustment,
      qa_feedback,
      error_message,
      updated_at,
      created_at,
      hero_shot:hero_shots(id, detected_shot_type, shot_type),
      swatch:swatches(id, name, sku_suffix),
      batch:generation_batches(project_id, project:projects(id, name, category))
    `);

  const filters: Record<string, unknown> = {};

  // Status
  const status = qp.get('status');
  if (status) {
    query = query.eq('status', status);
    filters.status = status;
  }

  // Model
  const model = qp.get('model');
  if (model) {
    query = query.ilike('gemini_model_used', `%${model}%`);
    filters.model = model;
  }

  // Attempt range
  const minAttempt = qp.get('min_attempt');
  if (minAttempt) {
    query = query.gte('attempt', parseInt(minAttempt, 10));
    filters.min_attempt = parseInt(minAttempt, 10);
  }
  const maxAttempt = qp.get('max_attempt');
  if (maxAttempt) {
    query = query.lte('attempt', parseInt(maxAttempt, 10));
    filters.max_attempt = parseInt(maxAttempt, 10);
  }

  // Score range
  const minScore = qp.get('min_score');
  if (minScore) {
    query = query.gte('qa_score', parseFloat(minScore));
    filters.min_score = parseFloat(minScore);
  }
  const maxScore = qp.get('max_score');
  if (maxScore) {
    query = query.lte('qa_score', parseFloat(maxScore));
    filters.max_score = parseFloat(maxScore);
  }

  // Date range
  const since = qp.get('since');
  if (since) {
    query = query.gte('updated_at', since);
    filters.since = since;
  }
  const until = qp.get('until');
  if (until) {
    query = query.lte('updated_at', until);
    filters.until = until;
  }

  // BRAND_ONLY filter
  const brandOnly = qp.get('brand_only');
  if (brandOnly === 'true' || brandOnly === '1') {
    query = query.eq('prompt_adjustment', 'BRAND_ONLY');
    filters.brand_only = true;
  }

  // Order
  const orderMap: Record<string, [string, boolean]> = {
    updated_desc: ['updated_at', false],
    updated_asc: ['updated_at', true],
    score_desc: ['qa_score', false],
    score_asc: ['qa_score', true],
    attempt_desc: ['attempt', false],
    created_desc: ['created_at', false],
  };
  const [orderCol, ascending] = orderMap[order] || orderMap.updated_desc;
  query = query.order(orderCol, { ascending });

  // Limit (we over-fetch because some filters apply post-join)
  query = query.limit(limit * 2);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });
  }

  type JoinedJob = {
    id: string;
    batch_id: string | null;
    status: string;
    attempt: number;
    qa_score: number | null;
    gemini_model_used: string | null;
    output_storage_path: string | null;
    prompt_adjustment: string | null;
    qa_feedback: string | null;
    error_message: string | null;
    updated_at: string;
    created_at: string;
    hero_shot: { id?: string; detected_shot_type?: string; shot_type?: string } | null;
    swatch: { id?: string; name?: string; sku_suffix?: string } | null;
    batch: { project_id?: string; project?: { id?: string; name?: string; category?: string } } | null;
  };

  // Post-join filters (things we couldn't express in a single .eq because of the nested joins)
  const projectId = qp.get('project_id');
  const projectName = qp.get('project_name');
  const category = qp.get('category');
  const swatchName = qp.get('swatch_name');
  const shotType = qp.get('shot_type');
  const text = qp.get('text');

  let jobs = (data || []) as unknown as JoinedJob[];

  if (projectId) {
    jobs = jobs.filter(j => j.batch?.project_id === projectId);
    filters.project_id = projectId;
  }
  if (projectName) {
    const needle = projectName.toLowerCase();
    jobs = jobs.filter(j => (j.batch?.project?.name || '').toLowerCase().includes(needle));
    filters.project_name = projectName;
  }
  if (category) {
    jobs = jobs.filter(j => j.batch?.project?.category === category);
    filters.category = category;
  }
  if (swatchName) {
    const needle = swatchName.toLowerCase();
    jobs = jobs.filter(j => (j.swatch?.name || '').toLowerCase().includes(needle));
    filters.swatch_name = swatchName;
  }
  if (shotType) {
    jobs = jobs.filter(j => (j.hero_shot?.detected_shot_type || j.hero_shot?.shot_type) === shotType);
    filters.shot_type = shotType;
  }
  if (text) {
    const needle = text.toLowerCase();
    jobs = jobs.filter(j => {
      const swatch = (j.swatch?.name || '').toLowerCase();
      const proj = (j.batch?.project?.name || '').toLowerCase();
      const id = j.id.toLowerCase();
      return swatch.includes(needle) || proj.includes(needle) || id.startsWith(needle);
    });
    filters.text = text;
  }

  // Trim to actual limit and flatten
  jobs = jobs.slice(0, limit);

  const flat = jobs.map(j => ({
    id: j.id,
    status: j.status,
    attempt: j.attempt,
    qa_score: j.qa_score,
    gemini_model: j.gemini_model_used,
    prompt_adjustment: j.prompt_adjustment,
    shot_type: j.hero_shot?.detected_shot_type || j.hero_shot?.shot_type || null,
    swatch: j.swatch?.name || null,
    swatch_sku: j.swatch?.sku_suffix || null,
    category: j.batch?.project?.category || null,
    project: j.batch?.project?.name || null,
    project_id: j.batch?.project_id || null,
    output_storage_path: j.output_storage_path,
    qa_feedback: j.qa_feedback ? j.qa_feedback.slice(0, 200) : null,
    error: j.error_message ? j.error_message.slice(0, 200) : null,
    updated_at: j.updated_at,
    debug_url: `/api/debug/jobs/${j.id}`,
  }));

  return NextResponse.json({
    total: flat.length,
    filters,
    order,
    limit,
    jobs: flat,
  });
}

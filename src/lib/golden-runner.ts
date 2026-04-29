/**
 * Programmatic golden-suite runner used by /api/admin/benchmarks/run.
 *
 * Mirrors the core loop of scripts/run-golden-set.ts but exposed as a
 * function so it can be invoked from a Next.js API route via `after()`.
 *
 * Each case persists its own row to golden_runs as it completes, so a
 * Vercel function timeout doesn't lose all results.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateImageSmart } from './image-providers';
import { MODEL_REGISTRY } from './models/registry';
import { getCategoryStrategy, getEffectiveMode, getEffectiveTemperature, buildPromptForMode } from './category-strategy';
import type { ProviderId } from './providers/types';

interface SuiteCase {
  id: string;
  description?: string;
  discovery_filter?: Record<string, unknown>;
  expected_min_score?: number;
}

interface Suite {
  suite: string;
  description?: string;
  version: number;
  default_min_score?: number;
  cases: SuiteCase[];
}

interface JobRow {
  id: string;
  attempt: number;
  prompt_metadata: Record<string, unknown> | null;
  hero_shot: { storage_path: string; mime_type: string | null; shot_type: string | null; detected_shot_type: string | null } | null;
  swatch: { storage_path: string; name: string; color_description: string | null; dominant_color_hex: string | null } | null;
  batch: { project: { category: string } | null } | null;
}

const JOB_SELECT = `
  id, batch_id, hero_shot_id, swatch_id, attempt, prompt_metadata, case_signature,
  hero_shot:hero_shots ( storage_path, mime_type, shot_type, detected_shot_type ),
  swatch:swatches ( storage_path, name, color_description, dominant_color_hex, sku_suffix ),
  batch:generation_batches ( project:projects ( category ) )
`.replace(/\s+/g, ' ');

function loadSuite(name: string): Suite {
  const filePath = path.join(process.cwd(), 'benchmarks', 'suites', `${name}.yaml`);
  if (!fs.existsSync(filePath)) throw new Error(`suite not found: ${name}`);
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Suite;
  if (!parsed?.cases?.length) throw new Error(`suite ${name} has no cases`);
  return parsed;
}

interface ResolvedCase {
  case_id: string;
  job: JobRow;
  expected_min_score: number;
}

async function resolveSuite(supabase: SupabaseClient, suite: Suite, defaultMin: number): Promise<ResolvedCase[]> {
  const out: ResolvedCase[] = [];
  for (const c of suite.cases) {
    const expectedMin = c.expected_min_score ?? defaultMin;
    const f = c.discovery_filter || {};
    let q = supabase.from('generation_jobs').select(JOB_SELECT);
    if (typeof f.case_signature === 'string') q = q.eq('case_signature', f.case_signature);
    if (typeof f.case_signature_like === 'string') q = q.like('case_signature', f.case_signature_like as string);
    if (Array.isArray(f.status_in)) q = q.in('status', f.status_in as string[]);
    const { data } = await q.limit(50);
    const targetCategories = typeof f.category === 'string'
      ? [f.category]
      : Array.isArray(f.category_in)
        ? (f.category_in as string[])
        : null;
    const filtered = ((data as unknown as JobRow[] | null) ?? []).filter((j) => {
      const cat = j.batch?.project?.category;
      if (!targetCategories) return true;
      return cat && targetCategories.includes(cat);
    });
    const pick = filtered.find((j) => j.hero_shot && j.swatch);
    if (pick) out.push({ case_id: c.id, job: pick, expected_min_score: expectedMin });
  }
  return out;
}

export interface RunSuiteResult {
  runId: string;
  ok: number;
  total: number;
  totalCostUsd: number;
}

export async function runSuiteAgainstModel(opts: {
  supabase: SupabaseClient;
  suiteName: string;
  modelId: ProviderId;
  runId: string;
}): Promise<RunSuiteResult> {
  const { supabase, suiteName, modelId, runId } = opts;
  if (!MODEL_REGISTRY[modelId]) throw new Error(`unknown model: ${modelId}`);
  const suite = loadSuite(suiteName);
  const cases = await resolveSuite(supabase, suite, suite.default_min_score ?? 0.70);

  let ok = 0;
  let totalCost = 0;
  for (const c of cases) {
    const r = await runOne(supabase, modelId, c, runId);
    if (r.ok) ok += 1;
    totalCost += r.cost_usd;
    await supabase.from('golden_runs').insert({
      run_id: runId,
      suite_name: suiteName,
      case_id: r.case_id,
      model_id_tested: modelId,
      score_total: r.score_total ?? null,
      score_per_dim: r.score_per_dim ?? null,
      cost_usd: r.cost_usd,
      duration_ms: r.duration_ms,
      output_path: r.output_path ?? null,
      run_metadata: { ok: r.ok, error: r.error || null, source_job_id: r.job_id, suite_version: suite.version },
    });
  }
  return { runId, ok, total: cases.length, totalCostUsd: totalCost };
}

interface CaseResult {
  case_id: string;
  job_id: string;
  ok: boolean;
  error?: string;
  cost_usd: number;
  duration_ms: number;
  output_path?: string;
  score_total?: number;
  score_per_dim?: Record<string, number>;
}

async function runOne(supabase: SupabaseClient, modelId: ProviderId, resolved: ResolvedCase, runId: string): Promise<CaseResult> {
  const { job } = resolved;
  if (!job.hero_shot || !job.swatch) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: 'missing hero/swatch', cost_usd: 0, duration_ms: 0 };
  }
  const category = job.batch?.project?.category || 'textile';
  const strategy = getCategoryStrategy(category);
  const shotType = job.hero_shot.detected_shot_type || job.hero_shot.shot_type || 'lifestyle';
  const mode = getEffectiveMode(strategy, job.attempt);
  const temperature = getEffectiveTemperature(strategy, mode, job.attempt);
  const darkSwatch = (job.prompt_metadata?.dark_swatch as boolean | undefined) ?? false;
  const swatchHex = job.swatch.dominant_color_hex || (job.prompt_metadata?.swatch_hex as string | undefined) || null;
  const colorDesc = job.swatch.color_description || (job.prompt_metadata?.swatch_color as string | undefined) || null;
  const patternsDiffer = job.prompt_metadata?.pattern_similarity === false;

  const prompt = buildPromptForMode(
    mode,
    strategy,
    job.swatch.name,
    colorDesc,
    shotType,
    darkSwatch,
    null,
    '1200x1200',
    swatchHex,
    patternsDiffer,
  );

  const [heroR, swatchR] = await Promise.all([
    supabase.storage.from('images').download(job.hero_shot.storage_path),
    supabase.storage.from('images').download(job.swatch.storage_path),
  ]);
  if (heroR.error || swatchR.error) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: `download failed`, cost_usd: 0, duration_ms: 0 };
  }
  const heroBuf = Buffer.from(await heroR.data!.arrayBuffer());
  const swatchBuf = Buffer.from(await swatchR.data!.arrayBuffer());

  const startedAt = Date.now();
  const result = await generateImageSmart(
    {
      heroImageBase64: heroBuf.toString('base64'),
      heroMimeType: job.hero_shot.mime_type || 'image/png',
      swatchImageBase64: swatchBuf.toString('base64'),
      swatchMimeType: 'image/png',
      promptText: prompt,
      temperature,
    },
    { category, shotType, attempt: 0, forcedModelId: modelId, swatchProfile: null },
  );
  const durationMs = Date.now() - startedAt;
  const costUsd = result.costEstimateUsd ?? MODEL_REGISTRY[modelId]?.costPerImageUsd ?? 0;

  if (!result.success || !result.imageBase64) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: result.error || 'no image', cost_usd: costUsd, duration_ms: durationMs };
  }

  const outputPath = `golden-runs/${runId}/${resolved.case_id}-${modelId}.png`;
  const buf = Buffer.from(result.imageBase64, 'base64');
  const upload = await supabase.storage.from('images').upload(outputPath, buf, {
    contentType: result.imageMimeType || 'image/png',
    upsert: true,
  });
  if (upload.error) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: `upload failed: ${upload.error.message}`, cost_usd: costUsd, duration_ms: durationMs };
  }

  return {
    case_id: resolved.case_id,
    job_id: job.id,
    ok: true,
    cost_usd: costUsd,
    duration_ms: durationMs,
    output_path: outputPath,
    score_total: 1.0,
    score_per_dim: { generation_succeeded: 1.0 },
  };
}

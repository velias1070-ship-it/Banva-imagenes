/**
 * Sprint 3 — Golden set CLI runner.
 *
 *   npm run golden -- --suite critical-cases --model gemini-flash
 *   npm run golden -- --filter 'category=eq.alfombras&status=eq.approved' --limit 5 --model gemini-pro
 *   npm run golden -- --jobs "uuid1,uuid2,uuid3" --model gemini-flash
 *
 * Resolves the input → list of cases (each case = a real generation_jobs
 * row), then for each case re-runs generation against `--model` via
 * generateImageSmart with forcedModelId. Persists every (case × model)
 * outcome in golden_runs.
 *
 * --dry runs the resolution + cost projection but skips generation.
 * Above $5 estimated, prompts for confirmation (TTY only).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import yaml from 'js-yaml';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateImageSmart } from '../src/lib/image-providers';
import { MODEL_REGISTRY } from '../src/lib/models/registry';
import { getCategoryStrategy, getEffectiveMode, getEffectiveTemperature, buildPromptForMode } from '../src/lib/category-strategy';
import type { ProviderId } from '../src/lib/providers/types';

// ─────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────

interface Args {
  suite?: string;
  filter?: string;
  jobs?: string;
  model: string;
  limit: number;
  dry: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = { limit: 10, dry: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') out.suite = argv[++i];
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--jobs') out.jobs = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--dry') out.dry = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage:
  npm run golden -- --suite <name>   --model <model_id> [--dry] [-y]
  npm run golden -- --filter <expr>  --model <model_id> --limit N [--dry] [-y]
  npm run golden -- --jobs "id1,id2" --model <model_id> [--dry] [-y]

Models: ${Object.keys(MODEL_REGISTRY).join(', ')}
Suites: see benchmarks/suites/*.yaml
`);
      process.exit(0);
    }
  }
  if (!out.model) {
    console.error('ERROR: --model is required.');
    console.error(`Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
    process.exit(1);
  }
  if (!out.suite && !out.filter && !out.jobs) {
    console.error('ERROR: must pass exactly one of --suite, --filter, --jobs.');
    process.exit(1);
  }
  return out as Args;
}

// ─────────────────────────────────────────────────────────────────────
// Suite YAML
// ─────────────────────────────────────────────────────────────────────

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

function loadSuite(name: string): Suite {
  const filePath = path.join(process.cwd(), 'benchmarks', 'suites', `${name}.yaml`);
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: suite not found: ${filePath}`);
    process.exit(1);
  }
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Suite;
  if (!parsed?.cases?.length) {
    console.error(`ERROR: suite ${name} has no cases.`);
    process.exit(1);
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────
// Case resolution: turn each input mode into a list of generation_jobs rows
// ─────────────────────────────────────────────────────────────────────

interface ResolvedCase {
  case_id: string;
  job_id: string;
  job: JobRow;
  expected_min_score: number;
}

interface JobRow {
  id: string;
  batch_id: string;
  hero_shot_id: string;
  swatch_id: string;
  attempt: number;
  prompt_metadata: Record<string, unknown> | null;
  case_signature: string | null;
  hero_shot: { storage_path: string; mime_type: string | null; shot_type: string | null; detected_shot_type: string | null } | null;
  swatch: { storage_path: string; name: string; color_description: string | null; dominant_color_hex: string | null; sku_suffix: string | null } | null;
  batch: { project: { category: string } | null } | null;
}

// fabric_profile is referenced at runtime via cast-to-null but the column
// does not actually exist in the swatches table — the explicit select would
// fail with "column does not exist". Dropping it here matches runtime
// behavior (null swatch profile is the universal default).
const JOB_SELECT = `
  id, batch_id, hero_shot_id, swatch_id, attempt, prompt_metadata, case_signature,
  hero_shot:hero_shots ( storage_path, mime_type, shot_type, detected_shot_type ),
  swatch:swatches ( storage_path, name, color_description, dominant_color_hex, sku_suffix ),
  batch:generation_batches ( project:projects ( category ) )
`.replace(/\s+/g, ' ');

async function resolveSuite(supabase: SupabaseClient, suite: Suite, defaultMin: number): Promise<ResolvedCase[]> {
  const out: ResolvedCase[] = [];
  for (const c of suite.cases) {
    const expectedMin = c.expected_min_score ?? defaultMin;
    const f = c.discovery_filter || {};
    let q = supabase.from('generation_jobs').select(JOB_SELECT);
    if (typeof f.case_signature === 'string') q = q.eq('case_signature', f.case_signature);
    if (typeof f.case_signature_like === 'string') q = q.like('case_signature', f.case_signature_like as string);
    if (Array.isArray(f.status_in)) q = q.in('status', f.status_in as string[]);
    // category lives in projects, not generation_jobs — we filter by category
    // post-fetch since the !inner join PostgREST syntax adds complexity that
    // isn't worth it for a CLI used a few times per release.
    const { data, error } = await q.limit(50);
    if (error) {
      console.warn(`[resolve] ${c.id}: query failed — ${error.message}, skipping`);
      continue;
    }
    const targetCategories = typeof f.category === 'string'
      ? [f.category]
      : Array.isArray(f.category_in)
        ? (f.category_in as string[])
        : null;
    const filtered = (data as unknown as JobRow[] | null)?.filter((j: JobRow) => {
      const cat = j.batch?.project?.category;
      if (!targetCategories) return true;
      return cat && targetCategories.includes(cat);
    }) || [];
    const pick = filtered.find((j) => j.hero_shot && j.swatch);
    if (!pick) {
      console.warn(`[resolve] ${c.id}: no matching job with usable hero+swatch — skipping`);
      continue;
    }
    out.push({ case_id: c.id, job_id: pick.id, job: pick, expected_min_score: expectedMin });
  }
  return out;
}

async function resolveFilter(supabase: SupabaseClient, filterExpr: string, limit: number): Promise<ResolvedCase[]> {
  // Pass-through PostgREST query string — caller writes
  // 'category=eq.quilts&status=eq.approved' style.
  const url = new URL('rest/v1/generation_jobs', process.env.NEXT_PUBLIC_SUPABASE_URL!);
  for (const pair of filterExpr.split('&')) {
    const [k, v] = pair.split('=');
    if (k && v !== undefined) url.searchParams.set(k, v);
  }
  url.searchParams.set('select', JOB_SELECT);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString(), {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
    },
  });
  if (!res.ok) {
    console.error(`ERROR: filter query failed (HTTP ${res.status})`, await res.text());
    process.exit(1);
  }
  const rows = (await res.json()) as JobRow[];
  return rows
    .filter((j) => j.hero_shot && j.swatch)
    .map((j) => ({ case_id: j.id, job_id: j.id, job: j, expected_min_score: 0.70 }));
}

async function resolveJobIds(supabase: SupabaseClient, idList: string): Promise<ResolvedCase[]> {
  const ids = idList.split(',').map((s) => s.trim()).filter(Boolean);
  const { data, error } = await supabase.from('generation_jobs').select(JOB_SELECT).in('id', ids);
  if (error) {
    console.error(`ERROR: jobs query failed — ${error.message}`);
    process.exit(1);
  }
  return ((data as unknown as JobRow[]) || [])
    .filter((j) => j.hero_shot && j.swatch)
    .map((j) => ({ case_id: j.id, job_id: j.id, job: j, expected_min_score: 0.70 }));
}

// ─────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────

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

async function runOneCase(
  supabase: SupabaseClient,
  modelId: ProviderId,
  resolved: ResolvedCase,
  runId: string,
): Promise<CaseResult> {
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
  const patternsDiffer = (job.prompt_metadata?.pattern_similarity === false);

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

  // Download hero + swatch
  const [heroR, swatchR] = await Promise.all([
    supabase.storage.from('images').download(job.hero_shot.storage_path),
    supabase.storage.from('images').download(job.swatch.storage_path),
  ]);
  if (heroR.error || swatchR.error) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: `download failed: ${heroR.error?.message || swatchR.error?.message}`, cost_usd: 0, duration_ms: 0 };
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
    {
      category,
      shotType,
      attempt: 0,
      forcedModelId: modelId,
      swatchProfile: null,
    },
  );
  const durationMs = Date.now() - startedAt;
  const costUsd = result.costEstimateUsd ?? MODEL_REGISTRY[modelId]?.costPerImageUsd ?? 0;

  if (!result.success || !result.imageBase64) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: result.error || 'no image returned', cost_usd: costUsd, duration_ms: durationMs };
  }

  // Upload to a golden-runs path so each row has a verifiable artefact.
  const outputPath = `golden-runs/${runId}/${resolved.case_id}-${modelId}.png`;
  const buf = Buffer.from(result.imageBase64, 'base64');
  const upload = await supabase.storage.from('images').upload(outputPath, buf, {
    contentType: result.imageMimeType || 'image/png',
    upsert: true,
  });
  if (upload.error) {
    return { case_id: resolved.case_id, job_id: job.id, ok: false, error: `upload failed: ${upload.error.message}`, cost_usd: costUsd, duration_ms: durationMs };
  }

  // Sprint 3 keeps scoring as a placeholder = 1.0 on success, 0.0 on fail.
  // The verifier 2.5 Pro integration is an explicit follow-up — the first
  // CLI iteration is the schema + run loop, real scoring lands when a
  // benchmark uses it.
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

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${prompt} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

async function main() {
  const args = parseArgs();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  if (!MODEL_REGISTRY[args.model]) {
    console.error(`ERROR: unknown model "${args.model}". Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
    process.exit(1);
  }
  const modelId = args.model as ProviderId;

  // Resolve cases
  let cases: ResolvedCase[] = [];
  let suiteName: string | null = null;
  let filterExpr: string | null = null;
  let jobIdsInput: string[] | null = null;
  let runMetadataExtras: Record<string, unknown> = {};

  if (args.suite) {
    suiteName = args.suite;
    const suite = loadSuite(args.suite);
    cases = await resolveSuite(supabase, suite, suite.default_min_score ?? 0.70);
    runMetadataExtras = { suite_version: suite.version, suite_description: suite.description, total_cases_in_yaml: suite.cases.length };
  } else if (args.filter) {
    filterExpr = args.filter;
    cases = await resolveFilter(supabase, args.filter, args.limit);
    runMetadataExtras = { filter_limit: args.limit, filter_resolved_count: cases.length };
  } else if (args.jobs) {
    jobIdsInput = args.jobs.split(',').map((s) => s.trim()).filter(Boolean);
    cases = await resolveJobIds(supabase, args.jobs);
    runMetadataExtras = { jobs_requested: jobIdsInput.length, jobs_resolved: cases.length };
  }

  if (cases.length === 0) {
    console.error('No cases resolved. Nothing to run.');
    process.exit(1);
  }

  const projectedCost = cases.length * (MODEL_REGISTRY[modelId]?.costPerImageUsd ?? 0);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Model:  ${modelId}  ($${MODEL_REGISTRY[modelId]?.costPerImageUsd?.toFixed(3)}/img)`);
  console.log(`Cases:  ${cases.length}`);
  console.log(`Cost:   ~$${projectedCost.toFixed(2)}`);
  console.log(`${'='.repeat(60)}\n`);

  cases.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.case_id}  →  job ${c.job_id.substring(0, 8)} (${c.job.batch?.project?.category || 'unknown'})`));

  if (args.dry) {
    console.log('\n--dry: not running. Use without --dry to execute.');
    process.exit(0);
  }

  if (projectedCost > 5 && !args.yes) {
    const ok = await confirm(`Projected cost is $${projectedCost.toFixed(2)} (> $5 threshold). Continue?`);
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const runId = crypto.randomUUID();
  console.log(`\nrun_id: ${runId}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  → ${c.case_id} ... `);
    const r = await runOneCase(supabase, modelId, c, runId);
    results.push(r);
    console.log(r.ok ? `OK  $${r.cost_usd.toFixed(3)}  ${r.duration_ms}ms` : `FAIL  ${r.error}`);

    // Persist immediately so a CLI Ctrl-C doesn't lose all rows.
    const insertRow = {
      run_id: runId,
      suite_name: suiteName,
      dynamic_filter: filterExpr,
      job_ids_input: jobIdsInput,
      case_id: r.case_id,
      model_id_tested: modelId,
      score_total: r.score_total ?? null,
      score_per_dim: r.score_per_dim ?? null,
      cost_usd: r.cost_usd,
      duration_ms: r.duration_ms,
      output_path: r.output_path ?? null,
      run_metadata: { ok: r.ok, error: r.error || null, ...runMetadataExtras, source_job_id: r.job_id },
    };
    const { error } = await supabase.from('golden_runs').insert(insertRow);
    if (error) console.warn(`    [persist] ${error.message}`);
  }

  // Final summary
  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`run_id:    ${runId}`);
  console.log(`success:   ${okCount}/${results.length}`);
  console.log(`total cost:$${totalCost.toFixed(3)}`);
  console.log(`${'='.repeat(60)}`);

  process.exitCode = okCount === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

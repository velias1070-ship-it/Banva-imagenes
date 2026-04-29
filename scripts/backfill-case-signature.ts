/**
 * Best-effort case_signature backfill — Sprint 2 issue #2.
 *
 * Reads jobs with NULL case_signature, reconstructs the signature from
 * available metadata using inferCaseSignatureFromJob(), and writes it back.
 *
 * Two reconstruction sources tag _telemetry_source:
 *   - 'sprint_1_runtime' — prompt_metadata has is_dark_swatch +
 *     pattern_similarity (jobs from Sprint 1 onwards)
 *   - 'backfill_inferred' — pipeline_log has PATTERN_COMPARED +
 *     DARK_SWATCH_DETECTED events (older jobs)
 *
 * Insufficient-metadata jobs are left NULL — model_performance excludes them
 * via WHERE case_signature IS NOT NULL.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/backfill-case-signature.ts
 *
 * Add --dry to preview without writing. Add --limit=N to cap the scan.
 *
 * Cost: $0 (read + update only, no API calls).
 */

import { createClient } from '@supabase/supabase-js';
import { inferCaseSignatureFromJob } from '../src/lib/case-signature';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const SCAN_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log(`[backfill] dry_run=${DRY_RUN} limit=${SCAN_LIMIT}`);

  // We need category from the project (not stored on the job). Pull all
  // projects upfront for a cheap lookup.
  const { data: projects } = await supabase
    .from('projects')
    .select('id, category');
  const projectCat = new Map<string, string>();
  for (const p of projects || []) projectCat.set(p.id, p.category || 'textile');
  console.log(`[backfill] cached ${projectCat.size} project categories`);

  // Pull jobs lacking case_signature in pages of 1000 (PostgREST default cap).
  type Row = {
    id: string;
    prompt_metadata: Record<string, unknown> | null;
    pipeline_log: Array<{ event: string; data?: unknown }> | null;
    hero_shot: { shot_type: string | null; detected_shot_type: string | null } | Array<{ shot_type: string | null; detected_shot_type: string | null }> | null;
    batch: { project_id: string } | Array<{ project_id: string }> | null;
  };
  const PAGE_SIZE = 1000;
  const jobs: Row[] = [];
  let from = 0;
  while (jobs.length < SCAN_LIMIT) {
    const { data: page, error: pageErr } = await supabase
      .from('generation_jobs')
      .select(`
        id,
        prompt_metadata,
        pipeline_log,
        hero_shot:hero_shots ( shot_type, detected_shot_type ),
        batch:generation_batches ( project_id )
      `)
      .is('case_signature', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (pageErr) {
      console.error('[fail] read error:', pageErr);
      process.exit(1);
    }
    if (!page || page.length === 0) break;
    jobs.push(...(page as unknown as Row[]));
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const total = jobs.length;
  console.log(`[backfill] scanning ${total} jobs with NULL case_signature`);

  const counts = {
    sprint_1_runtime: 0,
    backfill_inferred: 0,
    insufficient: 0,
    write_errors: 0,
  };

  for (const j of jobs || []) {
    const hero = Array.isArray(j.hero_shot) ? j.hero_shot[0] : j.hero_shot;
    const batch = Array.isArray(j.batch) ? j.batch[0] : j.batch;
    const projectId = batch?.project_id;
    const category = projectId ? projectCat.get(projectId) : null;

    const result = inferCaseSignatureFromJob({
      category,
      shot_type: hero?.shot_type,
      detected_shot_type: hero?.detected_shot_type,
      prompt_metadata: j.prompt_metadata as Record<string, unknown> | null,
      pipeline_log: j.pipeline_log as Array<{ event: string; data?: string | Record<string, unknown> | null }> | null,
    });

    counts[result.source]++;

    if (result.signature && !DRY_RUN) {
      // Patch _telemetry_source into prompt_metadata. We don't overwrite if
      // it's already set to a stronger value (sprint_1_runtime > backfill_inferred).
      const meta = (j.prompt_metadata as Record<string, unknown>) || {};
      const existingSource = meta._telemetry_source;
      const newSource = existingSource === 'sprint_1_runtime' ? 'sprint_1_runtime' : result.source;

      const { error: upErr } = await supabase
        .from('generation_jobs')
        .update({
          case_signature: result.signature,
          prompt_metadata: { ...meta, _telemetry_source: newSource },
        })
        .eq('id', j.id)
        .is('case_signature', null);

      if (upErr) {
        counts.write_errors++;
        console.error(`[fail] update ${j.id.slice(0, 8)}:`, upErr.message);
      }
    }
  }

  console.log('\n[summary]');
  console.log(`  sprint_1_runtime:   ${counts.sprint_1_runtime}`);
  console.log(`  backfill_inferred:  ${counts.backfill_inferred}`);
  console.log(`  insufficient:       ${counts.insufficient}`);
  console.log(`  write_errors:       ${counts.write_errors}`);
  const writable = counts.sprint_1_runtime + counts.backfill_inferred;
  console.log(`  recovered:          ${writable}/${total} (${total > 0 ? ((writable / total) * 100).toFixed(1) : 0}%)`);
  if (DRY_RUN) console.log('  (dry run — no writes performed)');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

/**
 * Sprint 3 — Golden run comparator CLI.
 *
 *   npm run golden:compare -- --base <run_id> --against <run_id>
 *   npm run golden:compare -- --base <run_id> --against <run_id> --persist
 *
 * Loads both runs from golden_runs, diffs them via compareRuns(), and
 * prints a markdown report. With --persist, writes a follow-up row that
 * sets compared_to_run_id back to the base, so the recommendation is
 * traceable.
 */

import { createClient } from '@supabase/supabase-js';
import { compareRuns, renderMarkdown, type GoldenRow } from '../src/lib/golden-comparator';

interface Args {
  base: string;
  against: string;
  persist: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = { persist: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--against') out.against = argv[++i];
    else if (a === '--persist') out.persist = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage:
  npm run golden:compare -- --base <run_id> --against <run_id> [--persist]
`);
      process.exit(0);
    }
  }
  if (!out.base || !out.against) {
    console.error('ERROR: --base and --against are required.');
    process.exit(1);
  }
  return out as Args;
}

async function main() {
  const args = parseArgs();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const [baseRes, againstRes] = await Promise.all([
    supabase.from('golden_runs').select('run_id, case_id, model_id_tested, score_total, cost_usd, duration_ms, run_metadata').eq('run_id', args.base),
    supabase.from('golden_runs').select('run_id, case_id, model_id_tested, score_total, cost_usd, duration_ms, run_metadata').eq('run_id', args.against),
  ]);

  if (baseRes.error || againstRes.error) {
    console.error('[fail]', baseRes.error?.message || againstRes.error?.message);
    process.exit(1);
  }
  if (!baseRes.data?.length) {
    console.error(`No rows found for base run_id ${args.base}`);
    process.exit(1);
  }
  if (!againstRes.data?.length) {
    console.error(`No rows found for against run_id ${args.against}`);
    process.exit(1);
  }

  const result = compareRuns(baseRes.data as GoldenRow[], againstRes.data as GoldenRow[]);
  const md = renderMarkdown(result, args.base, args.against);
  console.log(md);

  if (args.persist) {
    const followupRunId = crypto.randomUUID();
    const { error } = await supabase.from('golden_runs').insert({
      run_id: followupRunId,
      suite_name: 'comparison-followup',
      case_id: `compare-${args.base.substring(0, 8)}-vs-${args.against.substring(0, 8)}`,
      model_id_tested: result.against_model || 'unknown',
      compared_to_run_id: args.base,
      score_total: null,
      run_metadata: {
        recommendation: result.recommendation,
        reason: result.recommendation_reason,
        regressions: result.regressions.length,
        improvements: result.improvements.length,
        parity: result.parity.length,
        missing: result.missing.length,
        cost_delta_usd: result.totals.cost_delta_usd,
        comparison_target_run_id: args.against,
      },
    });
    if (error) {
      console.error(`\n[persist] failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`\n[persist] follow-up run row created: ${followupRunId}`);
  }

  process.exitCode = result.recommendation === 'DO_NOT_ADOPT' ? 1 : 0;
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

/**
 * Offline tests for src/lib/golden-comparator.ts.
 *
 * Pure logic — no DB, no API. Validates classification, recommendation
 * logic, and markdown rendering shape.
 *
 * Run:
 *   npx tsx scripts/test-golden-comparator.ts
 *
 * Cost: $0.
 */

import { compareRuns, renderMarkdown, type GoldenRow } from '../src/lib/golden-comparator';

let pass = 0;
let fail = 0;
const FAILURES: string[] = [];

function check(label: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    FAILURES.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function row(case_id: string, model_id: string, score: number | null, cost: number, duration: number): GoldenRow {
  return { run_id: 'r', case_id, model_id_tested: model_id, score_total: score, cost_usd: cost, duration_ms: duration, run_metadata: null };
}

console.log('\n[Group 1] Pure improvement → ADOPT');
{
  const base = [row('c1', 'flash', 0.70, 0.045, 5000), row('c2', 'flash', 0.65, 0.045, 5500)];
  const against = [row('c1', 'pro', 0.85, 0.134, 9000), row('c2', 'pro', 0.80, 0.134, 9500)];
  const r = compareRuns(base, against);
  check('improvements === 2', r.improvements.length === 2);
  check('regressions === 0', r.regressions.length === 0);
  check('recommendation === ADOPT', r.recommendation === 'ADOPT');
  check('cost_delta > 0 (Pro is more expensive)', r.totals.cost_delta_usd > 0);
}

console.log('\n[Group 2] Pure regression → DO_NOT_ADOPT');
{
  const base = [row('c1', 'pro', 0.85, 0.134, 9000)];
  const against = [row('c1', 'flash', 0.55, 0.045, 5000)];
  const r = compareRuns(base, against);
  check('regressions === 1', r.regressions.length === 1);
  check('recommendation === DO_NOT_ADOPT', r.recommendation === 'DO_NOT_ADOPT');
  check('score_delta < 0', (r.regressions[0].score_delta ?? 0) < 0);
}

console.log('\n[Group 3] Mixed → PARTIAL');
{
  const base = [row('c1', 'pro', 0.85, 0.134, 9000), row('c2', 'pro', 0.60, 0.134, 9500)];
  const against = [row('c1', 'gpt2', 0.55, 0.21, 11000), row('c2', 'gpt2', 0.85, 0.21, 11500)];
  const r = compareRuns(base, against);
  check('regressions >= 1', r.regressions.length >= 1);
  check('improvements >= 1', r.improvements.length >= 1);
  check('recommendation === PARTIAL', r.recommendation === 'PARTIAL');
}

console.log('\n[Group 4] Parity + cheaper → ADOPT');
{
  const base = [row('c1', 'pro', 0.85, 0.134, 9000), row('c2', 'pro', 0.80, 0.134, 9500)];
  const against = [row('c1', 'flash', 0.83, 0.045, 5000), row('c2', 'flash', 0.78, 0.045, 5500)];
  const r = compareRuns(base, against);
  check('within parity threshold', r.parity.length === 2);
  check('regressions 0', r.regressions.length === 0);
  check('cost cheaper', r.totals.cost_delta_usd < 0);
  check('recommendation === ADOPT', r.recommendation === 'ADOPT');
}

console.log('\n[Group 5] Parity + more expensive → DO_NOT_ADOPT');
{
  const base = [row('c1', 'flash', 0.85, 0.045, 5000)];
  const against = [row('c1', 'pro', 0.83, 0.134, 9000)];
  const r = compareRuns(base, against);
  check('parity', r.parity.length === 1);
  check('recommendation === DO_NOT_ADOPT', r.recommendation === 'DO_NOT_ADOPT');
}

console.log('\n[Group 6] Missing case in against → classified as missing');
{
  const base = [row('c1', 'flash', 0.85, 0.045, 5000), row('c2', 'flash', 0.80, 0.045, 5500)];
  const against = [row('c1', 'pro', 0.90, 0.134, 9000)];
  const r = compareRuns(base, against);
  check('total_cases includes union', r.total_cases === 2);
  const missingC2 = r.missing.find((m) => m.case_id === 'c2');
  check('c2 present in missing list', !!missingC2);
  check('c2 classification missing_in_against', missingC2?.classification === 'missing_in_against');
}

console.log('\n[Group 7] Custom thresholds');
{
  const base = [row('c1', 'flash', 0.80, 0.045, 5000)];
  const against = [row('c1', 'pro', 0.75, 0.134, 9000)];
  const lenient = compareRuns(base, against, { regressionThreshold: 0.10 });
  check('5pp drop with 10pp threshold → parity', lenient.parity.length === 1);
  const strict = compareRuns(base, against, { regressionThreshold: 0.03 });
  check('5pp drop with 3pp threshold → regression', strict.regressions.length === 1);
}

console.log('\n[Group 8] renderMarkdown output shape');
{
  const base = [row('c1', 'flash', 0.85, 0.045, 5000)];
  const against = [row('c1', 'pro', 0.95, 0.134, 9000)];
  const md = renderMarkdown(compareRuns(base, against), 'BASE-UUID', 'AGAINST-UUID');
  check('contains Recommendation header', md.includes('## Recommendation:'));
  check('contains base run_id', md.includes('BASE-UUID'));
  check('contains against run_id', md.includes('AGAINST-UUID'));
  check('contains Improvements section (improvement case)', md.includes('## Improvements'));
}

console.log('\n[Group 9] Both null scores → both_failed');
{
  const base = [row('c1', 'flash', null, 0.045, 5000)];
  const against = [row('c1', 'pro', null, 0.134, 9000)];
  const r = compareRuns(base, against);
  check("classification === 'both_failed'", r.missing[0].classification === 'both_failed');
  check('no regressions (failure not regression)', r.regressions.length === 0);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ All comparator behavior correct.');
process.exit(0);

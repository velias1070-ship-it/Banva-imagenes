/**
 * Offline tests for src/lib/cost-cap.ts.
 *
 * Pure logic — no DB, no API. Validates pipeline_log summing, cap
 * decision branching, and attempt-0 exemption.
 *
 * Run:
 *   npx tsx scripts/test-cost-cap-helpers.ts
 *
 * Cost: $0.
 *
 * NOTE: this is the helper test for Sprint 2 issue #3 (the runtime guard).
 * The other file scripts/test-cost-cap.ts is for the older
 * generateImageWithChain helper in image-providers.ts — they coexist
 * intentionally, they test different things.
 */

import {
  sumJobCostFromPipelineLog,
  evaluateCostCap,
  getCostCapForCategory,
} from '../src/lib/cost-cap';

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

console.log('\n[Group 1] sumJobCostFromPipelineLog — empty / null inputs');
{
  check('null → 0', sumJobCostFromPipelineLog(null) === 0);
  check('undefined → 0', sumJobCostFromPipelineLog(undefined) === 0);
  check('[] → 0', sumJobCostFromPipelineLog([]) === 0);
}

console.log('\n[Group 2] sumJobCostFromPipelineLog — happy path object data');
{
  const log = [
    { event: 'GENERATION_START', data: { temp: 0.2 } },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.045, model_id: 'gemini-flash' } },
    { event: 'VERIFICATION', data: 'PASS' },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.134, model_id: 'gemini-pro' } },
  ];
  const total = sumJobCostFromPipelineLog(log);
  check('sum 0.045 + 0.134 = 0.179', Math.abs(total - 0.179) < 1e-9);
}

console.log('\n[Group 3] sumJobCostFromPipelineLog — string-encoded data (legacy)');
{
  const log = [
    { event: 'PROVIDER_USED', data: JSON.stringify({ cost_usd: 0.21, model_id: 'gpt-image-2' }) },
    { event: 'PROVIDER_USED', data: JSON.stringify({ cost_usd: 0.045 }) },
  ];
  const total = sumJobCostFromPipelineLog(log);
  check('sum from string-encoded data', Math.abs(total - 0.255) < 1e-9);
}

console.log('\n[Group 4] sumJobCostFromPipelineLog — malformed entries are skipped');
{
  const log = [
    { event: 'PROVIDER_USED', data: { cost_usd: 0.045 } },
    { event: 'PROVIDER_USED', data: 'not-json' },
    { event: 'PROVIDER_USED', data: null },
    { event: 'PROVIDER_USED', data: { cost_usd: 'string-not-number' } },
    { event: 'PROVIDER_USED', data: { cost_usd: NaN } },
    { event: 'PROVIDER_USED', data: { cost_usd: -0.1 } },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.10 } },
  ];
  const total = sumJobCostFromPipelineLog(log);
  check('skips malformed; only counts valid', Math.abs(total - 0.145) < 1e-9);
}

console.log('\n[Group 5] sumJobCostFromPipelineLog — ignores other events');
{
  const log = [
    { event: 'GENERATION_START', data: { cost_usd: 999 } },
    { event: 'VERIFICATION', data: { cost_usd: 999 } },
    { event: 'MODE_SELECTED', data: { cost_usd: 999 } },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.045 } },
  ];
  check('only PROVIDER_USED counted', Math.abs(sumJobCostFromPipelineLog(log) - 0.045) < 1e-9);
}

console.log('\n[Group 6] evaluateCostCap — attempt 0 exempt');
{
  const d = evaluateCostCap({ attempt: 0, accumulatedUsd: 0.99, projectedNextUsd: 0.20, capUsd: 0.30 });
  check('attempt 0 → not enforced', d.enforced === false);
  check('attempt 0 → not exceeded (regardless of math)', d.exceeded === false);
  check('projected reported correctly', Math.abs(d.projectedUsd - 1.19) < 1e-9);
}

console.log('\n[Group 7] evaluateCostCap — attempt ≥ 1 enforced');
{
  const under = evaluateCostCap({ attempt: 1, accumulatedUsd: 0.045, projectedNextUsd: 0.134, capUsd: 0.30 });
  check('under cap → enforced=true, exceeded=false', under.enforced === true && under.exceeded === false);
  check('under cap → projected=0.179', Math.abs(under.projectedUsd - 0.179) < 1e-9);

  const over = evaluateCostCap({ attempt: 2, accumulatedUsd: 0.20, projectedNextUsd: 0.21, capUsd: 0.30 });
  check('over cap → exceeded=true', over.exceeded === true);
  check('over cap → projected=0.41', Math.abs(over.projectedUsd - 0.41) < 1e-9);

  const exactly = evaluateCostCap({ attempt: 3, accumulatedUsd: 0.20, projectedNextUsd: 0.10, capUsd: 0.30 });
  check('exactly at cap (0.30) → not exceeded (FP-tolerant)', exactly.exceeded === false);

  // 1¢ epsilon: jobs within $0.01 of the cap pass.
  const withinEpsilon = evaluateCostCap({ attempt: 3, accumulatedUsd: 0.20, projectedNextUsd: 0.105, capUsd: 0.30 });
  check('0.5¢ over cap (within epsilon) → not exceeded', withinEpsilon.exceeded === false);

  const justOver = evaluateCostCap({ attempt: 3, accumulatedUsd: 0.30, projectedNextUsd: 0.05, capUsd: 0.30 });
  check('5¢ over cap (beyond epsilon) → exceeded', justOver.exceeded === true);
}

console.log('\n[Group 8] getCostCapForCategory — known + unknown');
{
  // From config/routing-rules.json (committed in repo).
  check('quilts cap = 0.50', getCostCapForCategory('quilts') === 0.50);
  check('sabanas cap = 0.40', getCostCapForCategory('sabanas') === 0.40);
  check('cortinas cap = 0.50', getCostCapForCategory('cortinas') === 0.50);
  check('alfombras cap = 0.50', getCostCapForCategory('alfombras') === 0.50);
  check('brand cap = 0.20', getCostCapForCategory('brand') === 0.20);
  check('default fallback for unknown category', getCostCapForCategory('quesadillas') === 0.30);
  check('default fallback for null', getCostCapForCategory(null) === 0.30);
  check('default fallback for undefined', getCostCapForCategory(undefined) === 0.30);
}

console.log('\n[Group 9] Realistic chain trace');
{
  // Job ran Flash (failed verifier), then Pro (passed) — total $0.179, under quilts cap 0.50.
  const log = [
    { event: 'GENERATION_START', data: 'attempt 0' },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.045, model_id: 'gemini-flash' } },
    { event: 'VERIFICATION', data: 'FAIL' },
    { event: 'GENERATION_START', data: 'attempt 1' },
    { event: 'PROVIDER_USED', data: { cost_usd: 0.134, model_id: 'gemini-pro' } },
  ];
  const accumulated = sumJobCostFromPipelineLog(log);
  // Now ask: would attempt 2 (gpt-image-2 ~$0.21) exceed the quilts cap?
  const decision = evaluateCostCap({
    attempt: 2,
    accumulatedUsd: accumulated,
    projectedNextUsd: 0.21,
    capUsd: getCostCapForCategory('quilts'),
  });
  check('accumulated = 0.179', Math.abs(accumulated - 0.179) < 1e-9);
  check('projected = 0.389', Math.abs(decision.projectedUsd - 0.389) < 1e-9);
  check('under quilts cap (0.50) → not exceeded', decision.exceeded === false);

  // Same trace but on a category with cap=0.30 (default) → exceeded.
  const decision2 = evaluateCostCap({
    attempt: 2,
    accumulatedUsd: accumulated,
    projectedNextUsd: 0.21,
    capUsd: getCostCapForCategory('limpiapies'), // unknown → default 0.30
  });
  check('over default cap (0.30) → exceeded', decision2.exceeded === true);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ All cost-cap helpers correct.');
process.exit(0);

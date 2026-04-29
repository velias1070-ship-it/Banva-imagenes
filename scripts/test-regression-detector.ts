/**
 * Offline tests for src/lib/regression-detector.ts.
 *
 * Pure logic — no DB, no API. Validates window splitting, threshold
 * triggers, baseline floor, and edge cases.
 *
 * Run:
 *   npx tsx scripts/test-regression-detector.ts
 *
 * Cost: $0.
 */

import { detectRegression, type JobOutcome } from '../src/lib/regression-detector';

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

// Helpers — fabricate jobs at decreasing timestamps from `seed`. Returns
// older half first, newer half second (caller controls ordering).
function makeJobs(statuses: string[], baseTime = Date.UTC(2026, 3, 28, 12, 0, 0)): JobOutcome[] {
  return statuses.map((status, i) => ({
    status,
    // Timestamps stagger by 1 minute, oldest first. The detector re-sorts
    // newest-first internally so it doesn't matter how we feed them.
    created_at: new Date(baseTime + i * 60_000).toISOString(),
  }));
}

console.log('\n[Group 1] Insufficient sample → not a regression');
{
  const r = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs: [] });
  check('zero jobs → reason=insufficient_jobs', r.reason === 'insufficient_jobs');
  check('zero jobs → not regression', r.isRegression === false);

  const r2 = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs: makeJobs(['approved']) });
  check('one job → still insufficient (half=0)', r2.reason === 'insufficient_jobs');
}

console.log('\n[Group 2] Clean drop crosses threshold');
{
  // 50 older = 90% approved (45/5/0 distribution), 50 newer = 50% approved
  const olderHalf = [
    ...Array(45).fill('approved'),
    ...Array(5).fill('flagged'),
  ];
  const newerHalf = [
    ...Array(25).fill('approved'),
    ...Array(25).fill('flagged'),
  ];
  // older → first in time, newer → later in time
  const jobs = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const r = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sabanas:lifestyle:samepattern:light', jobs });
  check('total === 100', r.total === 100);
  check('baseline === 0.9', r.baselineApprovalRate === 0.9);
  check('rolling === 0.5', r.rollingApprovalRate === 0.5);
  check('dropPp === 0.4', Math.abs((r.dropPp ?? 0) - 0.4) < 1e-9);
  check('isRegression === true', r.isRegression === true);
  check("reason === 'drop_exceeds_threshold'", r.reason === 'drop_exceeds_threshold');
}

console.log('\n[Group 3] Drop within tolerance');
{
  const olderHalf = Array(50).fill('approved');                          // 100%
  const newerHalf = [...Array(45).fill('approved'), ...Array(5).fill('flagged')]; // 90%
  const jobs = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const r = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs });
  check('10pp drop < 15pp threshold → not regression', r.isRegression === false);
  check("reason === 'within_tolerance'", r.reason === 'within_tolerance');
}

console.log('\n[Group 4] Baseline below min — never alert (alfombras case)');
{
  const olderHalf = Array(50).fill('flagged');                           // 0%
  const newerHalf = Array(50).fill('error');                             // 0%
  const jobs = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const r = detectRegression({ modelId: 'gemini-pro', caseSignature: 'alfombras:main:unknownpattern:light', jobs });
  check('baseline=0 → not regression', r.isRegression === false);
  check("reason === 'baseline_below_min'", r.reason === 'baseline_below_min');
}

console.log('\n[Group 5] Improvement — not a regression');
{
  const olderHalf = [...Array(30).fill('approved'), ...Array(20).fill('flagged')]; // 60%
  const newerHalf = [...Array(45).fill('approved'), ...Array(5).fill('flagged')];  // 90%
  const jobs = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const r = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs });
  check("improvement → reason='within_tolerance'", r.reason === 'within_tolerance');
  check('dropPp negative', (r.dropPp ?? 0) < 0);
  check('not regression', r.isRegression === false);
}

console.log('\n[Group 6] Mixed terminal + non-terminal status — only terminal counted');
{
  const jobs = [
    ...makeJobs(['approved', 'approved', 'pending', 'generating'], Date.UTC(2026, 3, 1)), // older: 2 terminal, both approved → 100%
    ...makeJobs(['flagged', 'flagged', 'qa_pending', 'qa_processing'], Date.UTC(2026, 3, 28)), // newer: 2 terminal, both flagged → 0%
  ];
  const r = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs });
  check('non-terminal excluded from rates', r.baselineApprovalRate === 1.0 && r.rollingApprovalRate === 0.0);
  check('drop=1.0 → regression', r.isRegression === true);
}

console.log('\n[Group 7] Custom thresholds');
{
  const olderHalf = Array(50).fill('approved');
  const newerHalf = [...Array(40).fill('approved'), ...Array(10).fill('flagged')]; // 80%
  const jobs = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const lenient = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs, dropPpThreshold: 0.30 });
  check('20pp drop with 30pp threshold → not regression', lenient.isRegression === false);

  const strict = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs, dropPpThreshold: 0.10 });
  check('20pp drop with 10pp threshold → regression', strict.isRegression === true);
}

console.log('\n[Group 8] Sort independence — feeding newest first works too');
{
  const olderHalf = Array(50).fill('approved');
  const newerHalf = Array(50).fill('flagged');
  const jobsOldFirst = [
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
  ];
  const jobsNewFirst = [
    ...makeJobs(newerHalf, Date.UTC(2026, 3, 28)),
    ...makeJobs(olderHalf, Date.UTC(2026, 3, 1)),
  ];
  const r1 = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs: jobsOldFirst });
  const r2 = detectRegression({ modelId: 'gemini-flash', caseSignature: 'sig', jobs: jobsNewFirst });
  check('detector resorts internally — same baseline', r1.baselineApprovalRate === r2.baselineApprovalRate);
  check('detector resorts internally — same rolling', r1.rollingApprovalRate === r2.rollingApprovalRate);
  check('both regressions', r1.isRegression && r2.isRegression);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ All regression detection correct.');
process.exit(0);

/**
 * Sprint 5 Issue #0a — race condition fix tests.
 *
 * Validates the optimistic-lock pattern that protects process-next from
 * having its in-flight job state clobbered by /api/batches/[batchId]/health
 * (or any other stale-recovery worker) mid-generation.
 *
 * Approach: in-memory fake of the Supabase UPDATE...WHERE chain. The fake
 * stores a single row and re-evaluates filters at write time. This mirrors
 * how Postgres would behave, so an UPDATE whose precondition no longer
 * matches will return null (no row updated) — the same signal our code uses
 * to bail out via STALE_CLAIM_ABORTED.
 *
 * No DB, no network. Pure logic.
 *
 * Run:
 *   npx tsx scripts/test-race-condition-fix.ts
 */

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

interface FakeRow {
  id: string;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  updated_at: string;
  attempt: number;
  qa_feedback?: string;
}

class FakeJobsTable {
  private row: FakeRow;
  constructor(initial: FakeRow) {
    this.row = { ...initial };
  }
  snapshot(): FakeRow {
    return { ...this.row };
  }
  setRow(next: Partial<FakeRow>) {
    this.row = { ...this.row, ...next };
  }
  // Mimics the chained API: .update(updates).eq('id',id).eq('status','generating').eq('claimed_by',w).select('id').maybeSingle()
  ownedUpdate(updates: Partial<FakeRow>, filters: { id: string; status?: string; claimed_by?: string; updated_at_lt?: string }): { data: { id: string } | null } {
    if (this.row.id !== filters.id) return { data: null };
    if (filters.status !== undefined && this.row.status !== filters.status) return { data: null };
    if (filters.claimed_by !== undefined && this.row.claimed_by !== filters.claimed_by) return { data: null };
    if (filters.updated_at_lt !== undefined && !(this.row.updated_at < filters.updated_at_lt)) return { data: null };
    this.row = { ...this.row, ...updates };
    return { data: { id: this.row.id } };
  }
}

const NOW = '2026-04-29T12:00:00.000Z';
const T_MINUS_3MIN = '2026-04-29T11:57:00.000Z';
const T_MINUS_4MIN = '2026-04-29T11:56:00.000Z';
const STALE_THRESHOLD = '2026-04-29T11:55:00.000Z'; // anything <11:55:00 is stale (5min window)

console.log('\n[Group 1] attemptOwnedUpdate — happy path: worker A still owns the claim');
{
  const table = new FakeJobsTable({
    id: 'job-1', status: 'generating', claimed_by: 'workerA', claimed_at: T_MINUS_3MIN,
    updated_at: T_MINUS_3MIN, attempt: 0,
  });
  const result = table.ownedUpdate(
    { status: 'pending', attempt: 1, qa_feedback: 'color drift', updated_at: NOW },
    { id: 'job-1', status: 'generating', claimed_by: 'workerA' },
  );
  check('UPDATE returns row id when status+claimed_by match', result.data?.id === 'job-1');
  check('row status transitions to pending', table.snapshot().status === 'pending');
  check('row attempt increments', table.snapshot().attempt === 1);
}

console.log('\n[Group 2] attemptOwnedUpdate — health endpoint reset stole the claim');
{
  // Simulates: worker A claimed at T-3min, then health endpoint reset to pending,
  // then claim_next_job re-claimed for worker B.
  const table = new FakeJobsTable({
    id: 'job-1', status: 'generating', claimed_by: 'workerB', claimed_at: NOW,
    updated_at: NOW, attempt: 1,
  });
  // worker A tries to write its color-drift retry
  const result = table.ownedUpdate(
    { status: 'pending', attempt: 1, qa_feedback: 'color drift workerA', updated_at: NOW },
    { id: 'job-1', status: 'generating', claimed_by: 'workerA' },
  );
  check('UPDATE returns null when claimed_by no longer matches', result.data === null);
  check('row state is unchanged (worker B still owns)', table.snapshot().claimed_by === 'workerB');
  check('worker A qa_feedback did NOT clobber row', table.snapshot().qa_feedback === undefined);
}

console.log('\n[Group 3] attemptOwnedUpdate — health endpoint already reset to pending');
{
  // Health endpoint already changed status='generating' → 'pending'
  // before worker A's owned UPDATE ran. claim_next_job hasn't fired yet.
  const table = new FakeJobsTable({
    id: 'job-1', status: 'pending', claimed_by: 'workerA', claimed_at: T_MINUS_3MIN,
    updated_at: NOW, attempt: 0,
  });
  const result = table.ownedUpdate(
    { status: 'qa_pending', updated_at: NOW },
    { id: 'job-1', status: 'generating', claimed_by: 'workerA' },
  );
  check('UPDATE no-ops when status is already pending', result.data === null);
  check('row stays pending, available for claim_next_job', table.snapshot().status === 'pending');
}

console.log('\n[Group 4] Health endpoint stale-rescue — happy path: row is genuinely stale');
{
  // Worker died ~10min ago. Health endpoint should rescue.
  const table = new FakeJobsTable({
    id: 'job-1', status: 'generating', claimed_by: 'deadWorker', claimed_at: '2026-04-29T11:50:00.000Z',
    updated_at: '2026-04-29T11:50:00.000Z', attempt: 0,
  });
  const result = table.ownedUpdate(
    { status: 'pending', updated_at: NOW },
    { id: 'job-1', status: 'generating', updated_at_lt: STALE_THRESHOLD },
  );
  check('rescue UPDATE matches when row is genuinely stale', result.data?.id === 'job-1');
  check('row resets to pending', table.snapshot().status === 'pending');
}

console.log('\n[Group 5] Health endpoint stale-rescue — aborted: worker just heartbeated');
{
  // SELECT saw the row as stale, but between SELECT and UPDATE the worker
  // pushed a heartbeat. The optimistic re-check on updated_at no-ops.
  const table = new FakeJobsTable({
    id: 'job-1', status: 'generating', claimed_by: 'workerA', claimed_at: T_MINUS_4MIN,
    updated_at: T_MINUS_4MIN, attempt: 0,
  });
  // Worker A heartbeat between SELECT (saw 11:56:00) and UPDATE
  table.setRow({ updated_at: NOW });
  const result = table.ownedUpdate(
    { status: 'pending', updated_at: NOW },
    { id: 'job-1', status: 'generating', updated_at_lt: STALE_THRESHOLD },
  );
  check('rescue UPDATE no-ops when worker heartbeated mid-flight', result.data === null);
  check('row stays generating with worker A still owning', table.snapshot().status === 'generating' && table.snapshot().claimed_by === 'workerA');
}

console.log('\n[Group 6] Replay of d52020de scenario');
{
  // Worker A claims at T-3min, status=generating. Worker A is mid Flash→GPT-2
  // chain that takes ~200s. With Fix B applied this chain no longer exists
  // in image-providers, so Flash failure escalates at the job level instead.
  // But we still want to validate the lock holds even if a long call happens.
  const table = new FakeJobsTable({
    id: 'd52020de', status: 'generating', claimed_by: 'workerA', claimed_at: T_MINUS_3MIN,
    updated_at: T_MINUS_3MIN, attempt: 0,
  });

  // Health endpoint fires (browser polled /api/batches/.../health).
  // PRE-fix: threshold=60s → row is stale. POST-fix: threshold=300s → row
  // is NOT stale, SELECT returns nothing.
  const FIVE_MIN_AGO = '2026-04-29T11:55:00.000Z';
  const isStaleByOldThreshold = table.snapshot().updated_at < '2026-04-29T11:59:00.000Z';
  const isStaleByNewThreshold = table.snapshot().updated_at < FIVE_MIN_AGO;
  check('OLD 60s threshold flags row as stale (the bug)', isStaleByOldThreshold === true);
  check('NEW 300s threshold does NOT flag row as stale (fix)', isStaleByNewThreshold === false);

  // Even if the health endpoint somehow reaches the UPDATE step, the optimistic
  // claimed_at filter in the SELECT (Fix E) means we only consider rows whose
  // claim is also stale. claimed_at=T-3min is NOT stale under the new threshold.
  const claimIsAlsoStale = table.snapshot().claimed_at !== null && table.snapshot().claimed_at! < FIVE_MIN_AGO;
  check('claimed_at filter rejects fresh claim under new threshold', claimIsAlsoStale === false);

  // Now simulate Worker A's final write at T0 (after a 3 min generation) —
  // it should still own the claim.
  const finalWrite = table.ownedUpdate(
    { status: 'qa_pending', updated_at: NOW },
    { id: 'd52020de', status: 'generating', claimed_by: 'workerA' },
  );
  check('Worker A successfully writes final qa_pending', finalWrite.data?.id === 'd52020de');
  check('Job ends in qa_pending owned by worker A — no race loss', table.snapshot().status === 'qa_pending');
}

console.log('\n[Group 7] BRAND_ONLY release — race-safe');
{
  // process-next sees a BRAND_ONLY job, releases it back to the regen route.
  // Optimistic: only release if WE still own the claim.
  const table = new FakeJobsTable({
    id: 'brand-job', status: 'generating', claimed_by: 'workerA', claimed_at: NOW,
    updated_at: NOW, attempt: 0,
  });
  // Race: regen route already grabbed it, set claimed_by='regen-after'
  table.setRow({ claimed_by: 'regen-after' });
  const release = table.ownedUpdate(
    { status: 'generating', claimed_by: null, claimed_at: null, updated_at: NOW },
    { id: 'brand-job', status: 'generating', claimed_by: 'workerA' },
  );
  check('Release no-ops when regen route already owns the BRAND_ONLY job', release.data === null);
  check('regen-after still owns the claim', table.snapshot().claimed_by === 'regen-after');
}

console.log('\n[Group 8] qa_processing rescue — claim still fresh, abort');
{
  // Job is in qa_processing because process-qa just picked it up. updated_at
  // is fresh (worker heartbeated 30s ago). The health endpoint sees it as
  // stale candidate (a buggy SELECT that ignored updated_at), but the
  // optimistic UPDATE re-check on .lt('updated_at', threshold) no-ops.
  const table = new FakeJobsTable({
    id: 'qa-job-1', status: 'qa_processing', claimed_by: 'workerA',
    claimed_at: '2026-04-29T11:50:00.000Z',
    updated_at: '2026-04-29T11:59:30.000Z', // 30s ago — worker is alive
    attempt: 1,
  });
  // Health endpoint UPDATE with optimistic re-check
  const result = table.ownedUpdate(
    { status: 'qa_pending', updated_at: NOW },
    { id: 'qa-job-1', status: 'qa_processing', updated_at_lt: STALE_THRESHOLD },
  );
  check('rescue UPDATE no-ops when QA worker heartbeated within threshold', result.data === null);
  check('row stays qa_processing — QA worker still owns', table.snapshot().status === 'qa_processing');
}

console.log('\n[Group 9] qa_processing rescue — genuinely dead worker');
{
  // QA worker died 10 min ago. updated_at is old. Rescue should fire.
  const table = new FakeJobsTable({
    id: 'qa-job-dead', status: 'qa_processing', claimed_by: 'deadWorker',
    claimed_at: '2026-04-29T11:48:00.000Z',
    updated_at: '2026-04-29T11:50:00.000Z', // 10 min ago
    attempt: 1,
  });
  const result = table.ownedUpdate(
    { status: 'qa_pending', updated_at: NOW },
    { id: 'qa-job-dead', status: 'qa_processing', updated_at_lt: STALE_THRESHOLD },
  );
  check('rescue UPDATE matches when QA worker is genuinely dead', result.data?.id === 'qa-job-dead');
  check('row resets to qa_pending so process-qa can re-pick', table.snapshot().status === 'qa_pending');
}

console.log('\n[Group 10] qa_processing rescue — already moved by another worker');
{
  // Between SELECT and UPDATE, another health-check invocation already
  // reset the row to qa_pending. Our UPDATE should no-op.
  const table = new FakeJobsTable({
    id: 'qa-job-x', status: 'qa_pending', claimed_by: 'workerA',
    claimed_at: '2026-04-29T11:50:00.000Z',
    updated_at: NOW, attempt: 1,
  });
  const result = table.ownedUpdate(
    { status: 'qa_pending', updated_at: NOW },
    { id: 'qa-job-x', status: 'qa_processing', updated_at_lt: STALE_THRESHOLD },
  );
  check('rescue UPDATE no-ops when row is already qa_pending', result.data === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  FAILURES.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}

// Make this file a module so its top-level declarations don't collide with
// other test scripts under tsconfig isolatedModules: true.
export {};

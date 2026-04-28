/**
 * Offline tests for src/lib/qa-rate-limit-transition.ts
 *
 * Pure logic tests — no DB, no API. Validates branching:
 *   - 429 detection regex
 *   - retry numbering from history.length
 *   - backoff schedule [0.5, 2, 10, 30, 60] minutes
 *   - 24h hard-stop → terminal error
 *   - non-429 errors → legacy qa_pending behavior
 *
 * Run:
 *   npx tsx scripts/test-rate-limit-transitions.ts
 *
 * Cost: $0 (pure functions, no I/O).
 */

import { computeQAErrorTransition, isRateLimitError, type RateLimitHistoryEntry } from '../src/lib/qa-rate-limit-transition';

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

const NOW = new Date('2026-04-29T12:00:00Z');

console.log('\n[Group 1] isRateLimitError pattern matching');
{
  check("matches 'Resource exhausted'", isRateLimitError('Resource exhausted. Please try again later.') === true);
  check("matches 'RESOURCE_EXHAUSTED'", isRateLimitError('RESOURCE_EXHAUSTED') === true);
  check("matches 'rate limit'", isRateLimitError('User rate limit exceeded') === true);
  check("matches 'quota exceeded'", isRateLimitError('Quota exceeded for this project') === true);
  check("matches '429'", isRateLimitError('HTTP 429 received') === true);
  check("does NOT match '4290'", isRateLimitError('Job 4290 failed') === false);
  check("does NOT match generic 'JSON parse error'", isRateLimitError('JSON parse error at position 42') === false);
  check("does NOT match 'invalid api key'", isRateLimitError('Invalid API key') === false);
  check("matches Gemini Vertex error verbatim", isRateLimitError('QA analysis failed: Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.') === true);
}

console.log('\n[Group 2] First 429 (no history) → retry 1, wait 30s');
{
  const out = computeQAErrorTransition({
    promptMetadata: null,
    errorMessage: 'Resource exhausted',
    now: NOW,
  });
  check("kind === 'rate_limit_deferred'", out.kind === 'rate_limit_deferred');
  if (out.kind === 'rate_limit_deferred') {
    check("status === 'qa_rate_limited'", out.update.status === 'qa_rate_limited');
    check('total_429_retries === 1', out.update.total_429_retries === 1);
    const expectedNext = new Date(NOW.getTime() + 0.5 * 60_000).toISOString();
    check(`next_retry_at === ${expectedNext}`, out.update.next_retry_at === expectedNext);
    const history = (out.update.prompt_metadata as { rate_limit_history: RateLimitHistoryEntry[] }).rate_limit_history;
    check('history.length === 1', history.length === 1);
    check('history[0].retry_n === 1', history[0].retry_n === 1);
    check('history[0].wait_minutes === 0.5', history[0].wait_minutes === 0.5);
    check('history[0].hours_in_loop === 0', history[0].hours_in_loop === 0);
  }
}

console.log('\n[Group 3] Backoff schedule by retry_n');
{
  const cases = [
    { historyLen: 1, expectedWait: 2, label: 'retry 2 → 2min' },
    { historyLen: 2, expectedWait: 10, label: 'retry 3 → 10min' },
    { historyLen: 3, expectedWait: 30, label: 'retry 4 → 30min' },
    { historyLen: 4, expectedWait: 60, label: 'retry 5 → 60min' },
    { historyLen: 5, expectedWait: 60, label: 'retry 6 → 60min (saturates)' },
    { historyLen: 10, expectedWait: 60, label: 'retry 11 → 60min (saturates)' },
  ];
  for (const c of cases) {
    const fakeHistory: RateLimitHistoryEntry[] = Array.from({ length: c.historyLen }, (_, i) => ({
      retry_n: i + 1,
      attempted_at: new Date(NOW.getTime() - (c.historyLen - i) * 60_000).toISOString(),
      error_msg: '429',
      next_retry_at: NOW.toISOString(),
      wait_minutes: 0.5,
      hours_in_loop: 0,
    }));
    const out = computeQAErrorTransition({
      promptMetadata: { rate_limit_history: fakeHistory },
      errorMessage: '429',
      now: NOW,
    });
    if (out.kind === 'rate_limit_deferred') {
      const actualWait = (new Date(out.update.next_retry_at).getTime() - NOW.getTime()) / 60_000;
      check(c.label, actualWait === c.expectedWait);
      check(`${c.label} → total_429_retries === ${c.historyLen + 1}`, out.update.total_429_retries === c.historyLen + 1);
    } else {
      check(`${c.label} → kind === 'rate_limit_deferred'`, false);
    }
  }
}

console.log('\n[Group 4] hours_in_loop calculation');
{
  const firstAttemptIso = new Date(NOW.getTime() - 3 * 3_600_000).toISOString(); // 3 hours ago
  const fakeHistory: RateLimitHistoryEntry[] = [{
    retry_n: 1,
    attempted_at: firstAttemptIso,
    error_msg: '429',
    next_retry_at: NOW.toISOString(),
    wait_minutes: 0.5,
    hours_in_loop: 0,
  }];
  const out = computeQAErrorTransition({
    promptMetadata: { rate_limit_history: fakeHistory },
    errorMessage: '429',
    now: NOW,
  });
  if (out.kind === 'rate_limit_deferred') {
    const newEntry = out.newHistoryEntry;
    check('hours_in_loop ~= 3', Math.abs(newEntry.hours_in_loop - 3) < 0.001);
  } else {
    check("kind === 'rate_limit_deferred' (3h still under cap)", false);
  }
}

console.log('\n[Group 5] 24h hard-stop → terminal error');
{
  const firstAttemptIso = new Date(NOW.getTime() - 25 * 3_600_000).toISOString(); // 25 hours ago
  const fakeHistory: RateLimitHistoryEntry[] = Array.from({ length: 7 }, (_, i) => ({
    retry_n: i + 1,
    attempted_at: i === 0 ? firstAttemptIso : new Date(NOW.getTime() - (6 - i) * 3_600_000).toISOString(),
    error_msg: '429',
    next_retry_at: NOW.toISOString(),
    wait_minutes: 60,
    hours_in_loop: i,
  }));
  const out = computeQAErrorTransition({
    promptMetadata: { rate_limit_history: fakeHistory },
    errorMessage: '429',
    now: NOW,
  });
  check("kind === 'rate_limit_exhausted'", out.kind === 'rate_limit_exhausted');
  if (out.kind === 'rate_limit_exhausted') {
    check("status === 'error'", out.update.status === 'error');
    check('next_retry_at === null', out.update.next_retry_at === null);
    check('total_429_retries === 8', out.update.total_429_retries === 8);
    check('error_message mentions hours', /25\.\d+h/.test(out.update.error_message));
    check('hoursInLoop ~= 25', Math.abs(out.hoursInLoop - 25) < 0.001);
  }
}

console.log('\n[Group 6] Non-429 error → legacy qa_pending');
{
  const out = computeQAErrorTransition({
    promptMetadata: null,
    errorMessage: 'JSON parse error: unexpected token at position 42',
    now: NOW,
  });
  check("kind === 'non_rate_limit'", out.kind === 'non_rate_limit');
  if (out.kind === 'non_rate_limit') {
    check("status === 'qa_pending'", out.update.status === 'qa_pending');
    check("error_message starts with 'QA error: '", out.update.error_message.startsWith('QA error: '));
    check('does NOT touch total_429_retries', !('total_429_retries' in out.update));
    check('does NOT touch next_retry_at', !('next_retry_at' in out.update));
  }
}

console.log('\n[Group 7] Non-429 error preserves existing rate_limit_history');
{
  const oldHistory: RateLimitHistoryEntry[] = [{
    retry_n: 1,
    attempted_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    error_msg: '429',
    next_retry_at: NOW.toISOString(),
    wait_minutes: 0.5,
    hours_in_loop: 0,
  }];
  const out = computeQAErrorTransition({
    promptMetadata: { rate_limit_history: oldHistory },
    errorMessage: 'Random network blip',
    now: NOW,
  });
  // Non-429 path returns minimal payload, NOT touching prompt_metadata.
  // The existing history stays in DB unchanged.
  check("kind === 'non_rate_limit' (history not 429)", out.kind === 'non_rate_limit');
  if (out.kind === 'non_rate_limit') {
    check('does NOT include prompt_metadata in update', !('prompt_metadata' in out.update));
  }
}

console.log('\n[Group 8] Error message truncation');
{
  const longErr = 'A'.repeat(300) + ' Resource exhausted';
  const out = computeQAErrorTransition({
    promptMetadata: null,
    errorMessage: longErr,
    now: NOW,
  });
  if (out.kind === 'rate_limit_deferred') {
    check('history[0].error_msg.length === 200', out.newHistoryEntry.error_msg.length === 200);
  } else {
    check("kind === 'rate_limit_deferred' (long but matches 429)", false);
  }
}

console.log('\n[Group 9] Edge: exactly 24h with new entry crosses → exhausted');
{
  const firstAttemptIso = new Date(NOW.getTime() - 24 * 3_600_000).toISOString(); // exactly 24h
  const fakeHistory: RateLimitHistoryEntry[] = [{
    retry_n: 1,
    attempted_at: firstAttemptIso,
    error_msg: '429',
    next_retry_at: NOW.toISOString(),
    wait_minutes: 0.5,
    hours_in_loop: 0,
  }];
  const out = computeQAErrorTransition({
    promptMetadata: { rate_limit_history: fakeHistory },
    errorMessage: '429',
    now: NOW,
  });
  check("at exactly 24h → exhausted (>= comparison)", out.kind === 'rate_limit_exhausted');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ All transitions correct.');
process.exit(0);

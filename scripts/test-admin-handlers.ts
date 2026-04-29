/**
 * Sprint 4 unit tests for /api/admin/* handlers.
 *
 * Auth is bypassed in test mode via process.env.ADMIN_TEST_BYPASS=1
 * (gated by NODE_ENV !== 'production' inside admin-auth.ts).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-admin-handlers.ts
 */

let assertCount = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  assertCount += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`, detail ?? '');
    failed += 1;
  }
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ADMIN_TEST_BYPASS = '1';
  return fn().finally(() => { delete process.env.ADMIN_TEST_BYPASS; });
}

function withoutAdmin<T>(fn: () => Promise<T>): Promise<T> {
  delete process.env.ADMIN_TEST_BYPASS;
  return fn();
}

async function testAllowlistParsing() {
  console.log('\n── admin-auth: getAdminEmailAllowlist ──');
  const { getAdminEmailAllowlist } = await import('../src/lib/admin-auth');

  process.env.ADMIN_EMAILS = '';
  check('empty env → empty set', getAdminEmailAllowlist().size === 0);

  process.env.ADMIN_EMAILS = 'a@x.com';
  check('single email', getAdminEmailAllowlist().has('a@x.com'));

  process.env.ADMIN_EMAILS = 'a@x.com, B@X.COM ,c@x.com';
  const set = getAdminEmailAllowlist();
  check('csv with whitespace', set.size === 3 && set.has('c@x.com'));
  check('case-insensitive lowercased', set.has('b@x.com'));
}

async function testModelsRoute() {
  console.log('\n── PUT /api/admin/models ──');
  const mod = await import('../src/app/api/admin/models/route');

  await withoutAdmin(async () => {
    const res = await mod.PUT(makeReq({ default_chain: ['gemini-flash'], categories: {}, max_cost_per_job_usd: { default: 0.3 } }) as unknown as Parameters<typeof mod.PUT>[0]);
    check('returns 401 without admin', res.status === 401);
  });

  await withAdmin(async () => {
    const res = await mod.PUT(makeReq({ wrong: 'shape' }) as unknown as Parameters<typeof mod.PUT>[0]);
    check('returns 400 on schema-invalid body', res.status === 400);
  });

  await withAdmin(async () => {
    const res = await mod.PUT(makeReq({
      default_chain: ['unknown-model'],
      categories: {},
      max_cost_per_job_usd: { default: 0.3 },
    }) as unknown as Parameters<typeof mod.PUT>[0]);
    check('returns 400 on unknown model id in chain', res.status === 400);
  });

  // Valid body but no GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPO;
  await withAdmin(async () => {
    const res = await mod.PUT(makeReq({
      default_chain: ['gemini-flash', 'gemini-pro'],
      categories: { quilts: { attempts: ['gemini-flash', 'gemini-pro'] } },
      max_cost_per_job_usd: { default: 0.3 },
    }) as unknown as Parameters<typeof mod.PUT>[0]);
    check('returns 500 when GITHUB_TOKEN missing', res.status === 500);
  });
}

async function testBenchmarksRunRoute() {
  console.log('\n── POST /api/admin/benchmarks/run ──');
  const mod = await import('../src/app/api/admin/benchmarks/run/route');

  await withoutAdmin(async () => {
    const res = await mod.POST(makeReq({ suite: 'critical-cases', model: 'gemini-flash' }) as unknown as Parameters<typeof mod.POST>[0]);
    check('returns 401 without admin', res.status === 401);
  });

  await withAdmin(async () => {
    const res = await mod.POST(makeReq({ suite: 'critical-cases' }) as unknown as Parameters<typeof mod.POST>[0]);
    check('returns 400 on missing model', res.status === 400);
  });

  await withAdmin(async () => {
    const res = await mod.POST(makeReq({ suite: 'critical-cases', model: 'does-not-exist' }) as unknown as Parameters<typeof mod.POST>[0]);
    check('returns 400 on unknown model', res.status === 400);
  });
}

async function testPerformanceRefreshRoute() {
  console.log('\n── POST /api/admin/performance/refresh ──');
  const mod = await import('../src/app/api/admin/performance/refresh/route');

  await withoutAdmin(async () => {
    const res = await mod.POST();
    check('returns 401 without admin', res.status === 401);
  });
}

async function testCompareRoute() {
  console.log('\n── POST /api/admin/benchmarks/compare ──');
  const mod = await import('../src/app/api/admin/benchmarks/compare/route');

  await withoutAdmin(async () => {
    const res = await mod.POST(makeReq({ base: 'a', against: 'b' }) as unknown as Parameters<typeof mod.POST>[0]);
    check('returns 401 without admin', res.status === 401);
  });

  await withAdmin(async () => {
    const res = await mod.POST(makeReq({ base: 'only-base' }) as unknown as Parameters<typeof mod.POST>[0]);
    check('returns 400 when against missing', res.status === 400);
  });
}

async function main() {
  await testAllowlistParsing();
  await testModelsRoute();
  await testBenchmarksRunRoute();
  await testPerformanceRefreshRoute();
  await testCompareRoute();

  console.log('\n' + '='.repeat(60));
  console.log(`RESULTS: ${assertCount - failed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

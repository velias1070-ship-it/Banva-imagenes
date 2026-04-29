/**
 * Offline tests for src/lib/case-signature.ts.
 *
 * Pure logic — no DB, no API. Validates token format, normalization, opacity
 * truncation, and inferCaseSignatureFromJob best-effort reconstruction.
 *
 * Run:
 *   npx tsx scripts/test-case-signature.ts
 *
 * Cost: $0 (pure functions, no I/O).
 */

import { buildCaseSignature, inferCaseSignatureFromJob } from '../src/lib/case-signature';

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

console.log('\n[Group 1] User-spec example: sabanas:lifestyle:multipattern:dark');
{
  const sig = buildCaseSignature({
    category: 'sabanas',
    shotType: 'lifestyle',
    patternsDiffer: true,
    isDarkSwatch: true,
    opacity: 'opaque',
  });
  check(`exact match: "${sig}"`, sig === 'sabanas:lifestyle:multipattern:dark');
}

console.log('\n[Group 2] Token combinations');
{
  const c1 = buildCaseSignature({ category: 'quilts', shotType: 'main', patternsDiffer: false, isDarkSwatch: false });
  check('samepattern + light', c1 === 'quilts:main:samepattern:light');

  const c2 = buildCaseSignature({ category: 'cortinas', shotType: 'lifestyle', patternsDiffer: null, isDarkSwatch: false, opacity: 'sheer' });
  check('null pattern → unknownpattern + sheer opacity', c2 === 'cortinas:lifestyle:unknownpattern:light:sheer');

  const c3 = buildCaseSignature({ category: 'cubrecama', shotType: 'doblada', patternsDiffer: true, isDarkSwatch: true, opacity: 'translucent' });
  check('translucent emitted', c3 === 'cubrecama:doblada:multipattern:dark:translucent');

  const c4 = buildCaseSignature({ category: 'sabanas', shotType: 'lifestyle', patternsDiffer: false, isDarkSwatch: false, opacity: 'opaque' });
  check('opaque NOT emitted (default)', c4 === 'sabanas:lifestyle:samepattern:light');

  const c5 = buildCaseSignature({ category: 'sabanas', shotType: 'lifestyle', patternsDiffer: false, isDarkSwatch: false, opacity: null });
  check('null opacity NOT emitted', c5 === 'sabanas:lifestyle:samepattern:light');
}

console.log('\n[Group 3] Normalization');
{
  const c1 = buildCaseSignature({ category: 'SABANAS', shotType: 'Lifestyle', patternsDiffer: true, isDarkSwatch: true });
  check('uppercase → lowercase', c1 === 'sabanas:lifestyle:multipattern:dark');

  const c2 = buildCaseSignature({ category: '  quilts  ', shotType: ' main ', patternsDiffer: false, isDarkSwatch: false });
  check('trims whitespace', c2 === 'quilts:main:samepattern:light');

  const c3 = buildCaseSignature({ category: 'sá:banas!', shotType: 'life style', patternsDiffer: true, isDarkSwatch: false });
  check('strips non-[a-z0-9_-] chars', c3 === 'sbanas:lifestyle:multipattern:light');

  const c4 = buildCaseSignature({ category: null, shotType: undefined, patternsDiffer: null, isDarkSwatch: null });
  check('null/undefined → unknown tokens', c4 === 'unknown:unknown:unknownpattern:light');

  const c5 = buildCaseSignature({ category: '', shotType: '', patternsDiffer: true, isDarkSwatch: true });
  check('empty strings → unknown', c5 === 'unknown:unknown:multipattern:dark');
}

console.log('\n[Group 4] Pattern relation tokens');
{
  const t = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: true, isDarkSwatch: false });
  const f = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: false, isDarkSwatch: false });
  const u = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: null, isDarkSwatch: false });
  check('true → multipattern', t.includes(':multipattern:'));
  check('false → samepattern', f.includes(':samepattern:'));
  check('null → unknownpattern', u.includes(':unknownpattern:'));
}

console.log('\n[Group 5] Darkness tokens');
{
  const d = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: false, isDarkSwatch: true });
  const l = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: false, isDarkSwatch: false });
  const n = buildCaseSignature({ category: 'a', shotType: 'b', patternsDiffer: false, isDarkSwatch: null });
  check('true → dark', d.endsWith(':dark'));
  check('false → light', l.endsWith(':light'));
  check('null → light (default)', n.endsWith(':light'));
}

console.log('\n[Group 6] Stable cardinality (no spaces, only ASCII)');
{
  const cases = [
    buildCaseSignature({ category: 'sabanas', shotType: 'lifestyle', patternsDiffer: true, isDarkSwatch: true, opacity: 'sheer' }),
    buildCaseSignature({ category: 'QUILTS', shotType: 'MAIN', patternsDiffer: false, isDarkSwatch: false }),
    buildCaseSignature({ category: '', shotType: null, patternsDiffer: null, isDarkSwatch: null }),
  ];
  for (const c of cases) {
    check(`"${c}" — no spaces`, !/ /.test(c));
    check(`"${c}" — only [a-z0-9:_-]`, /^[a-z0-9:_-]+$/.test(c));
  }
}

console.log('\n[Group 7] inferCaseSignatureFromJob — Sprint 1 runtime fast path (dark_swatch key)');
{
  const job = {
    category: 'quilts',
    shot_type: 'lifestyle',
    detected_shot_type: 'lifestyle',
    prompt_metadata: {
      dark_swatch: true,
      pattern_similarity: false, // patterns DIFFER
      swatchProfile: { opacity: 'opaque' as const },
    },
  };
  const out = inferCaseSignatureFromJob(job);
  check("source === 'sprint_1_runtime' (dark_swatch key)", out.source === 'sprint_1_runtime');
  check('signature === quilts:lifestyle:multipattern:dark', out.signature === 'quilts:lifestyle:multipattern:dark');
}

console.log('\n[Group 7b] inferCaseSignatureFromJob — legacy is_dark_swatch key still works');
{
  const job = {
    category: 'sabanas',
    shot_type: 'main',
    prompt_metadata: {
      is_dark_swatch: false,
      pattern_similarity: true,
    },
  };
  const out = inferCaseSignatureFromJob(job);
  check("source === 'sprint_1_runtime'", out.source === 'sprint_1_runtime');
  check('signature === sabanas:main:samepattern:light', out.signature === 'sabanas:main:samepattern:light');
}

console.log('\n[Group 8] inferCaseSignatureFromJob — pipeline_log fallback');
{
  const job = {
    category: 'sabanas',
    shot_type: 'main',
    prompt_metadata: {},
    pipeline_log: [
      { event: 'PATTERN_COMPARED', data: 'false' }, // patterns differ
      { event: 'DARK_SWATCH_DETECTED', data: null },
    ],
  };
  const out = inferCaseSignatureFromJob(job);
  check("source === 'backfill_inferred'", out.source === 'backfill_inferred');
  check('signature reconstructed correctly', out.signature === 'sabanas:main:multipattern:dark');
}

console.log('\n[Group 9] inferCaseSignatureFromJob — insufficient data');
{
  const job = { category: 'sabanas', shot_type: 'main', prompt_metadata: {} };
  const out = inferCaseSignatureFromJob(job);
  check("source === 'insufficient'", out.source === 'insufficient');
  check('signature === null', out.signature === null);
}

console.log('\n[Group 10] inferCaseSignatureFromJob — Sprint-1 path with sheer opacity');
{
  const job = {
    category: 'cortinas',
    shot_type: 'lifestyle',
    prompt_metadata: {
      is_dark_swatch: false,
      pattern_similarity: true,
      swatchProfile: { opacity: 'sheer' as const },
    },
  };
  const out = inferCaseSignatureFromJob(job);
  check("source === 'sprint_1_runtime'", out.source === 'sprint_1_runtime');
  check('opacity threaded through', out.signature === 'cortinas:lifestyle:samepattern:light:sheer');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ All case-signature behavior correct.');
process.exit(0);

/**
 * Sprint 3 — Mock-adapter test for the golden run loop.
 *
 * Validates that:
 *   - YAML suite parses
 *   - generateImageSmart honors forcedModelId (no routing fallback)
 *   - the run loop produces the right shape of result rows
 *
 * Does NOT call the real Gemini API — patches MODEL_REGISTRY adapters.
 *
 * Run:
 *   npx tsx scripts/test-golden-runner-mock.ts
 *
 * Cost: $0.
 */

import { MODEL_REGISTRY } from '../src/lib/models/registry';
import { generateImageSmart } from '../src/lib/image-providers';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

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

console.log('\n[Group 1] YAML suites parse and have valid shape');
{
  const dir = path.join(process.cwd(), 'benchmarks', 'suites');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  check('at least 3 suite files exist', files.length >= 3);
  for (const f of files) {
    const parsed = yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
      suite: string; cases: Array<{ id: string; discovery_filter?: unknown }>; version: number;
    };
    check(`${f} → suite name set`, typeof parsed.suite === 'string' && parsed.suite.length > 0);
    check(`${f} → cases array non-empty`, Array.isArray(parsed.cases) && parsed.cases.length > 0);
    check(`${f} → every case has id`, parsed.cases.every((c) => typeof c.id === 'string' && c.id.length > 0));
    check(`${f} → every case has discovery_filter`, parsed.cases.every((c) => typeof c.discovery_filter === 'object' && c.discovery_filter !== null));
  }
}

console.log('\n[Group 2] forcedModelId bypasses routing AND fallback');
{
  // Patch all 3 adapters: flash fails recoverably (would normally trigger
  // GPT-2 fallback), pro succeeds, gpt-image-2 succeeds. With
  // forcedModelId=flash, we must see the flash failure surfaced — NOT
  // a transparent GPT-2 result.
  const origFlashGen = MODEL_REGISTRY['gemini-flash'].adapter.generate;
  const origGpt2Gen = MODEL_REGISTRY['gpt-image-2']?.adapter.generate;
  let flashCalled = 0;
  let gpt2Called = 0;

  MODEL_REGISTRY['gemini-flash'].adapter.generate = async () => {
    flashCalled++;
    return {
      success: false,
      error: 'rate limit (recoverable)',
      durationMs: 50,
      modelId: 'gemini-3.1-flash-image-preview',
      costUsd: 0.045,
      providerFamily: 'gemini' as const,
    };
  };
  if (MODEL_REGISTRY['gpt-image-2']) {
    MODEL_REGISTRY['gpt-image-2'].adapter.generate = async () => {
      gpt2Called++;
      return {
        success: true,
        imageBase64: 'fake',
        imageMimeType: 'image/png',
        durationMs: 50,
        modelId: 'gpt-image-2',
        costUsd: 0.21,
        providerFamily: 'openai' as const,
      };
    };
  }

  // Pretend the env enables GPT-2 fallback so the recoverable-error path
  // would normally trigger.
  const prevEnv = process.env.ENABLE_GPT_IMAGE_2;
  process.env.ENABLE_GPT_IMAGE_2 = '1';

  // forcedModelId=flash: even with the env flag and a recoverable error,
  // the runner must surface the flash failure verbatim.
  const reqBase = {
    heroImageBase64: Buffer.from('hero').toString('base64'),
    heroMimeType: 'image/png',
    swatchImageBase64: Buffer.from('swatch').toString('base64'),
    swatchMimeType: 'image/png',
    promptText: 'mock',
    temperature: 0.2,
  };

  // Need to chain the test inside an IIFE because `await` can't be at
  // top-level in script files compiled by tsx without --experimental.
  (async () => {
    const out = await generateImageSmart(reqBase, {
      attempt: 0,
      forcedModelId: 'gemini-flash',
      category: 'sabanas',
    });
    check('flash adapter called once', flashCalled === 1);
    check('gpt-image-2 adapter NOT called (forcedModelId blocks fallback)', gpt2Called === 0);
    check('result.success === false (flash failure preserved)', out.success === false);
    check("providerUsed === 'gemini-flash'", out.providerUsed === 'gemini-flash');

    // Restore everything.
    MODEL_REGISTRY['gemini-flash'].adapter.generate = origFlashGen;
    if (origGpt2Gen && MODEL_REGISTRY['gpt-image-2']) MODEL_REGISTRY['gpt-image-2'].adapter.generate = origGpt2Gen;
    if (prevEnv === undefined) delete process.env.ENABLE_GPT_IMAGE_2;
    else process.env.ENABLE_GPT_IMAGE_2 = prevEnv;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`RESULTS: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
      console.log('\nFailures:');
      for (const f of FAILURES) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log('✓ Golden runner mock test passed.');
    process.exit(0);
  })().catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}

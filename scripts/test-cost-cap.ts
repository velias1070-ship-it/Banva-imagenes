/**
 * Cost Cap Validation — offline test of generateImageWithChain.
 *
 * Verifies that lib/image-providers.ts:278 (generateImageWithChain) honors
 * max_cost_per_job_usd from config/routing-rules.json: attempt 0 always
 * runs, attempt N>0 is short-circuited if projected accumulatedCost exceeds
 * the cap, and the result carries costCapped: true.
 *
 * Status: dev-only. Not invoked from runtime (process-next uses
 * generateImageSmart, which is single-attempt and ignores the cap).
 * Sprint 2 will integrate the cap into the runtime chain — this script
 * stays for regression testing of the helper itself.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-cost-cap.ts
 *
 * Cost: ~$0.045 (one Flash generation for attempt 0).
 *
 * The script writes a temp override of config/routing-rules.json with
 * max_cost_per_job_usd.default = 0.01 so the second attempt would always
 * exceed the cap, then restores the file in `finally` (even on crash).
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'routing-rules.json');

// Hero + swatch from job a5426398 (validated end-to-end during Sprint 1 close).
// Category resolves via routing-rules → uses default cap (which we override).
const HERO_PATH = 'projects/4b9042a7-d586-4a38-bd10-07183c71824e/heroes/efa7a5da-af80-4b9e-b15a-fd62a5651e69.png';
const SWATCH_PATH = 'projects/4b9042a7-d586-4a38-bd10-07183c71824e/swatches/60f58ad9-c962-41a5-987e-1a5cc09dc942.webp';

async function main() {
  // 1. Override config with cap = 0.01 BEFORE importing image-providers
  //    (the module caches the rules at first load via cachedRules).
  const original = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(original);
  const overridden = {
    ...parsed,
    max_cost_per_job_usd: {
      ...parsed.max_cost_per_job_usd,
      default: 0.01,
    },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(overridden, null, 2));
  console.log('[setup] config override applied — default cap = $0.01');

  try {
    // 2. Dynamic import AFTER config override so cachedRules picks up the cap
    const { generateImageWithChain } = await import('../src/lib/image-providers');
    const { MODEL_REGISTRY } = await import('../src/lib/models/registry');

    // 3. Mock the adapters to simulate generation outcomes WITHOUT calling the
    //    real API. We only want to validate the cap arithmetic, not Gemini.
    //    - attempt 0 (gemini-flash) → fail (forces the chain to want to escalate)
    //    - attempt 1 (gemini-pro)  → would succeed if invoked, but cap should
    //                                 short-circuit before generate() is called.
    let flashCalled = 0;
    let proCalled = 0;
    let gpt2Called = 0;
    MODEL_REGISTRY['gemini-flash'].adapter.generate = async () => {
      flashCalled++;
      return {
        success: false,
        error: 'simulated failure for cost cap test',
        durationMs: 50,
        modelId: 'gemini-3.1-flash-image-preview',
        costUsd: 0.045,
      };
    };
    MODEL_REGISTRY['gemini-pro'].adapter.generate = async () => {
      proCalled++;
      return {
        success: true,
        imageBase64: 'fake',
        imageMimeType: 'image/png',
        durationMs: 50,
        modelId: 'gemini-3-pro-image-preview',
        costUsd: 0.134,
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
        };
      };
    }

    // 4. Run the chain. With cap=$0.01 and Flash cost=$0.045:
    //    - attempt 0 always runs (cap not enforced at i=0).
    //    - Flash fails (mocked). accumulatedCost += 0.045 → 0.045.
    //    - attempt 1 (gemini-pro): projectedCost = 0.045 + 0.134 = 0.179 > 0.01 → cap fires.
    //    - Returns last bestResult with costCapped: true.
    console.log('[run] generateImageWithChain — mocked adapters, default chain, cap=$0.01');
    void HERO_PATH; void SWATCH_PATH; void createClient;
    const heroB64 = Buffer.from('hero').toString('base64');
    const swatchB64 = Buffer.from('swatch').toString('base64');
    const start = Date.now();
    const result = await generateImageWithChain(
      {
        heroImageBase64: heroB64,
        heroMimeType: 'image/png',
        swatchImageBase64: swatchB64,
        swatchMimeType: 'image/webp',
        promptText: 'Apply the exact color and pattern from image 2 to the textile of image 1. Keep composition.',
        temperature: 0.2,
      },
      {
        attempt: 0,
        useProModel: false,
      },
    );

    console.log(`[run] elapsed=${Date.now() - start}ms`);

    // 5. Validate
    const summary = {
      success: result.success,
      attemptsMade: result.attemptsMade,
      costCapped: result.costCapped,
      providerUsed: result.providerUsed,
      modelIdUsed: result.modelIdUsed,
      costEstimateUsd: result.costEstimateUsd,
      durationMs: result.durationMs,
      error: result.error,
    };
    console.log('[result]', JSON.stringify(summary, null, 2));

    const checks = {
      'attemptsMade === 1': result.attemptsMade === 1,
      'costCapped === true': result.costCapped === true,
      "providerUsed === 'gemini-flash'": result.providerUsed === 'gemini-flash',
      'flash adapter called once': flashCalled === 1,
      'pro adapter NOT called': proCalled === 0,
      'gpt2 adapter NOT called': gpt2Called === 0,
      'success=false (Flash failed)': result.success === false,
    };
    console.log('[validation]');
    for (const [name, passed] of Object.entries(checks)) {
      console.log(`  ${passed ? '✓' : '✗'} ${name}`);
    }
    const allPassed = Object.values(checks).every(Boolean);
    console.log(allPassed ? '\n✓ COST CAP HELPER WORKS AS SPECIFIED' : '\n✗ COST CAP HELPER FAILED');

    process.exitCode = allPassed ? 0 : 1;
  } finally {
    // 6. Restore config no matter what
    fs.writeFileSync(CONFIG_PATH, original);
    console.log('[teardown] config restored');
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

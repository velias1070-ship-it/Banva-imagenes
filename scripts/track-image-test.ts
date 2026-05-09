/**
 * One-shot diagnostic: re-run the same edit job ee3db1e6 with the swatch
 * properly cropped to its fabric zone. Goal: confirm whether the original
 * failure was caused by the swatch being a full lifestyle photo
 * (`_from_result.png`) and Gemini cloning its composition.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/track-image-test.ts <jobId>
 *
 * Outputs:
 *   /tmp/track_swatch_cropped.png — the cropped swatch sent to Gemini
 *   /tmp/track_result_v2.png      — the new generation result
 */

import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { cropSwatchToFabric } from '../src/lib/image-processing';
import { generateImage } from '../src/lib/gemini/client';

const JOB_ID = process.argv[2];
if (!JOB_ID) {
  console.error('usage: tsx scripts/track-image-test.ts <jobId> [outTag]');
  process.exit(2);
}
const OUT_TAG = process.argv[3] || JOB_ID.slice(0, 8);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

async function downloadFromImages(path: string): Promise<Buffer> {
  const { data, error } = await sb.storage.from('images').download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function main() {
  const { data: job } = await sb.from('generation_jobs').select('*').eq('id', JOB_ID).single();
  if (!job) throw new Error(`job ${JOB_ID} not found`);
  const { data: hero } = await sb.from('hero_shots').select('*').eq('id', job.hero_shot_id).single();
  const { data: swatch } = await sb.from('swatches').select('*').eq('id', job.swatch_id).single();
  if (!hero || !swatch) throw new Error('hero/swatch missing');

  console.log(`[track] job=${JOB_ID} status=${job.status} attempt=${job.attempt} category=${job.prompt_metadata?.category}`);
  console.log(`[track] hero=${hero.filename} (${hero.shot_type})`);
  console.log(`[track] swatch=${swatch.name} path=${swatch.storage_path}`);
  console.log(`[track] original output=${job.output_storage_path}`);

  const heroBuf = await downloadFromImages(hero.storage_path);
  const swatchBuf = await downloadFromImages(swatch.storage_path);
  const originalBuf = job.output_storage_path ? await downloadFromImages(job.output_storage_path).catch(() => null) : null;
  if (originalBuf) {
    fs.writeFileSync(`/tmp/track_${OUT_TAG}_v1.png`, originalBuf);
    console.log(`[track] original v1 saved -> /tmp/track_${OUT_TAG}_v1.png`);
  }
  fs.writeFileSync(`/tmp/track_${OUT_TAG}_hero.png`, heroBuf);
  fs.writeFileSync(`/tmp/track_${OUT_TAG}_swatch.png`, swatchBuf);

  const swatchCropped = await cropSwatchToFabric(swatchBuf);
  fs.writeFileSync(`/tmp/track_${OUT_TAG}_swatch_cropped.png`, swatchCropped);
  console.log(`[track] cropped swatch -> /tmp/track_${OUT_TAG}_swatch_cropped.png (${swatchCropped.length}B)`);

  const promptText = job.prompt_text as string;
  console.log(`[track] using job prompt (${promptText.length} chars)`);

  const t0 = Date.now();
  const result = await generateImage({
    heroImageBase64: heroBuf.toString('base64'),
    heroMimeType: 'image/png',
    swatchImageBase64: swatchCropped.toString('base64'),
    swatchMimeType: 'image/jpeg',
    promptText,
    temperature: 0.2,
    useProModel: true, // match original (Pro for sabanas regen)
  });
  console.log(`[track] gemini done in ${Date.now() - t0}ms success=${result.success}`);

  if (!result.success || !result.imageBase64) {
    console.error(`[track] FAILED: ${result.error}`);
    console.error(`[track] meta:`, JSON.stringify(result.meta, null, 2));
    process.exit(1);
  }

  const out = Buffer.from(result.imageBase64, 'base64');
  const outPath = `/tmp/track_${OUT_TAG}_v2.png`;
  fs.writeFileSync(outPath, out);
  console.log(`[track] new result saved -> ${outPath} (${out.length}B)`);
  console.log(`[track] model=${result.meta?.modelUsed} finish=${result.meta?.finishReason}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

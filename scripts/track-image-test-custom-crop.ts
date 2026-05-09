/**
 * Variant of track-image-test.ts with a configurable crop region.
 * Targets multi-zone swatches where the default cropSwatchToFabric()
 * extracts the wrong band (e.g. Boking: black quilt mid-zone vs white
 * striped sheet at bottom).
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/track-image-test-custom-crop.ts <jobId> <tag> <yPct> <hPct>
 *
 *   yPct: top of crop as 0-1 fraction of image height
 *   hPct: crop height as 0-1 fraction of image height
 */

import fs from 'fs';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { generateImage } from '../src/lib/gemini/client';

const JOB_ID = process.argv[2];
const TAG = process.argv[3] || 'custom';
const Y_PCT = parseFloat(process.argv[4] || '0.20');
const H_PCT = parseFloat(process.argv[5] || '0.30');

if (!JOB_ID) {
  console.error('usage: tsx scripts/track-image-test-custom-crop.ts <jobId> <tag> <yPct> <hPct>');
  process.exit(2);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function dl(path: string): Promise<Buffer> {
  const { data, error } = await sb.storage.from('images').download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function customCrop(buf: Buffer, yPct: number, hPct: number): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const W = meta.width || 1000, H = meta.height || 1000;
  const left = Math.round(W * 0.10);
  const top = Math.round(H * yPct);
  const w = Math.round(W * 0.80);
  const h = Math.round(H * hPct);
  console.log(`[crop] ${W}x${H} -> x=${left}-${left + w} y=${top}-${top + h}`);
  return sharp(buf)
    .extract({ left, top, width: Math.min(w, W - left), height: Math.min(h, H - top) })
    .resize(800, 800, { fit: 'cover' })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function main() {
  const { data: job } = await sb.from('generation_jobs').select('*').eq('id', JOB_ID).single();
  if (!job) throw new Error('job not found');
  const { data: hero } = await sb.from('hero_shots').select('*').eq('id', job.hero_shot_id).single();
  const { data: swatch } = await sb.from('swatches').select('*').eq('id', job.swatch_id).single();

  console.log(`[track] job=${JOB_ID} swatch=${swatch!.name} crop=y${Y_PCT}+h${H_PCT}`);

  const heroBuf = await dl(hero!.storage_path);
  const swatchBuf = await dl(swatch!.storage_path);

  const cropped = await customCrop(swatchBuf, Y_PCT, H_PCT);
  const cropPath = `/tmp/track_${TAG}_swatch_crop.png`;
  fs.writeFileSync(cropPath, cropped);
  console.log(`[track] swatch crop -> ${cropPath}`);

  const t0 = Date.now();
  const result = await generateImage({
    heroImageBase64: heroBuf.toString('base64'),
    heroMimeType: 'image/png',
    swatchImageBase64: cropped.toString('base64'),
    swatchMimeType: 'image/jpeg',
    promptText: job.prompt_text as string,
    temperature: 0.2,
    useProModel: true,
  });
  console.log(`[track] gemini ${Date.now() - t0}ms success=${result.success}`);
  if (!result.success || !result.imageBase64) {
    console.error('FAILED:', result.error, result.meta);
    process.exit(1);
  }
  const out = `/tmp/track_${TAG}_v3.png`;
  fs.writeFileSync(out, Buffer.from(result.imageBase64, 'base64'));
  console.log(`[track] result -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

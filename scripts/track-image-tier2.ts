/**
 * Tier-2 generation for sabanas detail shots.
 * Uses the swatch as the only image reference + a descriptive prompt
 * to compose a two-piece detail (quilt over flat sheet).
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/track-image-tier2.ts <jobId>
 */

import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { generateImage } from '../src/lib/gemini/client';

const JOB_ID = process.argv[2];
if (!JOB_ID) {
  console.error('usage: tsx scripts/track-image-tier2.ts <jobId>');
  process.exit(2);
}
const TAG = JOB_ID.slice(0, 8);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const dl = async (p: string) => Buffer.from(await (await sb.storage.from('images').download(p)).data!.arrayBuffer());

const PROMPT = `Generate a photorealistic close-up detail shot of a bedding set in 1024x1024.

The set has two pieces visible in the frame:
- TOP HALF: a quilt/cubrecama draped diagonally, showing the dominant pattern from the upper part of the reference image (the duvet/quilt zone). Natural fabric folds and creases.
- BOTTOM HALF: a flat sheet/sabana plana underneath the quilt edge, showing the pattern from the lower part of the reference image (the flat sheet zone). The sheet has soft folds.
- BOUNDARY: the diagonal edge where the quilt meets the flat sheet is the focal point — both fabrics are clearly visible, the quilt edge curves over the sheet.

Lighting: soft natural daylight, slight shadows under fabric folds.
Composition: extreme close-up, no headboard, no pillows visible, no models, no overlays, no text, no watermarks, no logos. Just the two fabrics meeting at a diagonal.

CRITICAL: Use the EXACT colors and patterns from the reference image (Image 1). Replicate the textile pattern faithfully — same colors, same motifs, same scale.

Photorealistic textile photography, fabric texture visible, no AI artifacts. Output 1024x1024.`;

async function main() {
  const { data: job } = await sb.from('generation_jobs').select('*').eq('id', JOB_ID).single();
  if (!job) throw new Error('job not found');
  const { data: swatch } = await sb.from('swatches').select('*').eq('id', job.swatch_id).single();
  console.log(`[tier2] job=${JOB_ID} swatch=${swatch!.name}`);

  const swatchBuf = await dl(swatch!.storage_path);
  fs.writeFileSync(`/tmp/track_${TAG}_swatch.png`, swatchBuf);

  const t0 = Date.now();
  const r = await generateImage({
    swatchImageBase64: swatchBuf.toString('base64'),
    swatchMimeType: 'image/jpeg',
    promptText: PROMPT,
    temperature: 0.4,
    useProModel: true,
  });
  console.log(`[tier2] ${Date.now() - t0}ms success=${r.success} finish=${r.meta?.finishReason}`);
  if (!r.success || !r.imageBase64) {
    console.error('FAILED:', r.error);
    if (r.textResponse) console.error('text:', r.textResponse.slice(0, 300));
    process.exit(1);
  }
  const out = `/tmp/track_${TAG}_tier2.png`;
  fs.writeFileSync(out, Buffer.from(r.imageBase64, 'base64'));
  console.log(`[tier2] saved -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

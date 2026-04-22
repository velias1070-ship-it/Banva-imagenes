/**
 * A/B Test: GPT Image 2 vs Gemini for problematic jobs.
 *
 * Takes a list of job_ids that previously failed in production, downloads
 * their hero + swatch from Supabase, sends to gpt-image-2 via OpenAI's
 * /v1/images/edits with both images labeled, computes Delta-E vs swatch,
 * saves result + reports.
 *
 * Required env (put in .env.local):
 *   OPENAI_API_KEY=sk-...
 *   SUPABASE_SERVICE_ROLE_KEY=...  (already present)
 *   NEXT_PUBLIC_SUPABASE_URL=...   (already present)
 *
 * Run:
 *   npx tsx scripts/ab_test_gpt_image_2.ts
 *
 * Output:
 *   /tmp/banva_ab_gpt2/<job_id>_gpt2.png
 *   /tmp/banva_ab_gpt2/report.json
 *   /tmp/banva_ab_gpt2/report.md
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { computeSwatchOutputDeltaE } from '../src/lib/image-processing';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '/tmp/banva_ab_gpt2';

// Test set: 10 jobs that previously failed (update with real IDs from your data)
const TEST_JOBS = [
  // alfombras pattern (where Gemini fails worst)
  { id: '06ee451f-3e8f-4abb-a3ad-b8374b4be497', note: 'alfombras Girl (owls)' },
  { id: '401e67b9-5e06-4218-92b9-be94a1ba3453', note: 'alfombras Space' },
  { id: '5f6b8782-697a-406d-a78b-67ad318af003', note: 'alfombras Cream (Flash fail)' },
  // cortinas (normal + sheer)
  { id: '694d2005-46f6-48c2-b2bb-ed28de7149c0', note: 'cortinas Blanco SHEER (velo → linen bug)' },
  { id: '13fb9aff-d47a-4533-82c3-62e4357c7670', note: 'cortinas Moka (baseline)' },
  // sabanas (pattern invent cases)
  { id: 'fd0a0d49-ed82-468f-b0f2-64282b2480af', note: 'sabanas Lady (Hello Kitty, was rejected)' },
  { id: '6176b189-55f6-49e7-a48e-3a2b5b0bb2a0', note: 'sabanas Unicornio' },
  // quilts
  { id: '47cd4dda-72f0-43c1-a45f-7a84359b9df1', note: 'quilts Rosa (baseline)' },
];

type OpenAIImageResponse = {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; type?: string };
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
}

async function supaGet(path: string): Promise<unknown> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY!, Authorization: `Bearer ${SUPA_KEY}` },
  });
  return res.json();
}

async function supaDownload(storagePath: string): Promise<Buffer> {
  const res = await fetch(`${SUPA_URL}/storage/v1/object/images/${storagePath}`, {
    headers: { apikey: SUPA_KEY!, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${storagePath}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Build a side-by-side composite: hero on left, swatch on right, labels
 * rendered so the VLM can reference them as "image 1" / "image 2".
 * GPT Image 2 can handle multi-image input natively but the single-composite
 * approach (Flux Kontext style) also works well and is simpler to dispatch.
 */
async function composeHeroAndSwatch(heroBuf: Buffer, swatchBuf: Buffer): Promise<Buffer> {
  const size = 1024;
  const [hero, swatch] = await Promise.all([
    sharp(heroBuf).resize(size, size, { fit: 'cover' }).png().toBuffer(),
    sharp(swatchBuf).resize(size, size, { fit: 'cover' }).png().toBuffer(),
  ]);
  return sharp({
    create: { width: size * 2, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: hero, left: 0, top: 0 },
      { input: swatch, left: size, top: 0 },
    ])
    .png()
    .toBuffer();
}

async function generateWithGPTImage2(heroBuf: Buffer, swatchBuf: Buffer, category: string): Promise<{ imageBuf: Buffer; cost: number; latencyMs: number }> {
  const t0 = Date.now();
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  // Two images: API accepts image[] as multiple files for compositing.
  const heroBlob = new Blob([new Uint8Array(heroBuf)], { type: 'image/png' });
  const swatchBlob = new Blob([new Uint8Array(swatchBuf)], { type: 'image/png' });
  form.append('image[]', heroBlob, 'hero.png');
  form.append('image[]', swatchBlob, 'swatch.png');
  form.append('prompt',
    `Apply the color and fabric pattern from image 2 (swatch reference) to ALL textile/fabric surfaces of the product shown in image 1 (hero composition). ` +
    `Preserve exactly: composition, camera angle, lighting, background, furniture, shadows, reflections from image 1. ` +
    `Do NOT preserve the original fabric color or pattern from image 1 — replace it completely with image 2's fabric. ` +
    `The product category is "${category}". Output MUST be photorealistic, 1:1 square, 1024x1024, with the same composition as image 1.`);
  form.append('size', '1024x1024');
  form.append('quality', 'high');
  form.append('output_format', 'png');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  const data = (await res.json()) as OpenAIImageResponse;
  if (!res.ok || !data.data?.[0]?.b64_json) {
    throw new Error(`OpenAI error: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  const imageBuf = Buffer.from(data.data[0].b64_json, 'base64');
  // Cost: high quality 1024×1024 ≈ $0.21 per image standard
  return { imageBuf, cost: 0.21, latencyMs: Date.now() - t0 };
}

async function run() {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  if (!SUPA_URL || !SUPA_KEY) throw new Error('Supabase env not set');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const report: Array<Record<string, unknown>> = [];
  let totalCost = 0;

  for (const test of TEST_JOBS) {
    console.log(`\n=== ${test.note} (${test.id.slice(0, 8)}) ===`);
    try {
      const jobs = (await supaGet(`generation_jobs?id=eq.${test.id}&select=hero_shot_id,swatch_id,prompt_metadata,output_storage_path`)) as Array<{
        hero_shot_id: string | null;
        swatch_id: string;
        prompt_metadata: { category?: string; swatch_color?: string; strategy?: string };
        output_storage_path: string | null;
      }>;
      if (!jobs?.length) { console.log('  job not found'); continue; }
      const job = jobs[0];
      const pm = job.prompt_metadata || {};
      const category = pm.category || 'textile';

      // Resolve hero path: either from hero_shot or (for user_upload/ML import) from output_storage_path
      let heroStoragePath: string | null = null;
      if (job.hero_shot_id) {
        const hs = (await supaGet(`hero_shots?id=eq.${job.hero_shot_id}&select=storage_path`)) as Array<{ storage_path: string }>;
        heroStoragePath = hs[0]?.storage_path || null;
      } else if (job.output_storage_path) {
        heroStoragePath = job.output_storage_path;
      }
      if (!heroStoragePath) { console.log('  no hero available'); continue; }

      const sw = (await supaGet(`swatches?id=eq.${job.swatch_id}&select=storage_path,dominant_color_hex`)) as Array<{ storage_path: string; dominant_color_hex: string | null }>;
      if (!sw[0]) { console.log('  swatch not found'); continue; }
      const cachedHex = sw[0].dominant_color_hex;

      const [heroBuf, swatchBuf] = await Promise.all([
        supaDownload(heroStoragePath),
        supaDownload(sw[0].storage_path),
      ]);

      console.log(`  hero=${heroStoragePath.slice(-40)} swatch=${sw[0].storage_path.slice(-40)}`);
      console.log(`  category=${category}, color=${pm.swatch_color}, cached_hex=${cachedHex || 'null'}`);

      const { imageBuf, cost, latencyMs } = await generateWithGPTImage2(heroBuf, swatchBuf, category);
      totalCost += cost;
      const outPath = path.join(OUT_DIR, `${test.id.slice(0, 8)}_gpt2.png`);
      fs.writeFileSync(outPath, imageBuf);
      console.log(`  ✓ generated (${latencyMs}ms, \$${cost}) → ${outPath}`);

      // Compute Delta-E vs swatch (use the same logic as production)
      const croppedSwatch = await sharp(swatchBuf).extract({
        left: Math.round((await sharp(swatchBuf).metadata()).width! * 0.2),
        top: Math.round((await sharp(swatchBuf).metadata()).height! * 0.5),
        width: Math.round((await sharp(swatchBuf).metadata()).width! * 0.6),
        height: Math.round((await sharp(swatchBuf).metadata()).height! * 0.28),
      }).resize(800, 800, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();

      const dE = await computeSwatchOutputDeltaE(croppedSwatch, imageBuf, {
        swatchOriginalBuffer: swatchBuf,
        swatchOriginalMime: 'image/webp',
        cachedSwatchHex: cachedHex,
      });
      console.log(`  ΔE=${dE.deltaE.toFixed(1)}  sw=${JSON.stringify(dE.swatchRgb)} out=${JSON.stringify(dE.outputRgb)} swSrc=${dE.swatchSource} outSrc=${dE.outputSource}`);

      report.push({
        job_id: test.id,
        note: test.note,
        category,
        color: pm.swatch_color,
        deltaE: Math.round(dE.deltaE * 10) / 10,
        deltaE_pass: dE.deltaE <= 25,
        swatch_rgb: dE.swatchRgb,
        output_rgb: dE.outputRgb,
        swatch_source: dE.swatchSource,
        output_source: dE.outputSource,
        cost_usd: cost,
        latency_ms: latencyMs,
        output_path: outPath,
      });
    } catch (err) {
      console.error(`  ERROR:`, err instanceof Error ? err.message : err);
      report.push({ job_id: test.id, note: test.note, error: err instanceof Error ? err.message : String(err) });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  // Markdown report
  const passed = report.filter(r => r.deltaE_pass).length;
  const total = report.filter(r => !r.error).length;
  const md = [
    `# GPT Image 2 A/B Test Report`,
    ``,
    `**Total jobs tested:** ${report.length}`,
    `**Delta-E pass:** ${passed} / ${total} (${total ? Math.round(passed / total * 100) : 0}%)`,
    `**Total cost:** $${totalCost.toFixed(2)}`,
    ``,
    `| Job | Category | Color | ΔE | Pass | Cost | Latency |`,
    `|---|---|---|---|---|---|---|`,
    ...report.map(r => r.error
      ? `| ${(r.job_id as string).slice(0, 8)} | — | — | ERR | ❌ | $0 | — |`
      : `| ${(r.job_id as string).slice(0, 8)} | ${r.category} | ${r.color || '?'} | ${r.deltaE} | ${r.deltaE_pass ? '✅' : '❌'} | $${r.cost_usd} | ${r.latency_ms}ms |`
    ),
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md);

  console.log(`\n=== RESUMEN ===`);
  console.log(`Jobs: ${report.length}, ΔE pass: ${passed}/${total}, cost: $${totalCost.toFixed(2)}`);
  console.log(`Report: ${path.join(OUT_DIR, 'report.md')}`);
}

run().catch(e => { console.error(e); process.exit(1); });

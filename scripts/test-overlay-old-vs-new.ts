/**
 * Compara overlay viejo (30/4: FAR=50, BIN=60, no binarizacion + sharp bug
 * = stats globales) vs overlay nuevo (1/5: FAR=80, BIN=100 + sharp fix)
 * sobre la MISMA imagen Flash RAW + hero real + bboxes reales del DB.
 *
 * Goal: confirmar que con el codigo del 30/4 los highlights del polar
 * blanco se DROPEAN y la sabana queda limpia.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

const HERO_PATH = '/tmp/hero_smudge.png';
const RAW_PATH = '/tmp/hero_review/routing_fix/sample_1_raw_flash02.png';
const OUT_DIR = '/tmp/hero_review/old_vs_new';
mkdirSync(OUT_DIR, { recursive: true });

const REAL_BBOXES = [
  { x: 100, y: 36, width: 60, height: 56 },
  { x: 24, y: 104, width: 212, height: 28 },
  { x: 51, y: 135, width: 157, height: 26 },
  { x: 784, y: 107, width: 414, height: 119 },
  { x: 937, y: 330, width: 41, height: 43 },
  { x: 998, y: 345, width: 189, height: 65 },
  { x: 937, y: 524, width: 41, height: 43 },
  { x: 998, y: 539, width: 129, height: 65 },
  { x: 937, y: 707, width: 41, height: 43 },
  { x: 998, y: 716, width: 167, height: 100 },
  { x: 937, y: 894, width: 41, height: 43 },
  { x: 998, y: 903, width: 188, height: 100 },
  { x: 937, y: 1078, width: 41, height: 43 },
  { x: 998, y: 1087, width: 169, height: 100 },
  { x: 182, y: 1121, width: 191, height: 65 },
];

type Bbox = { x: number; y: number; width: number; height: number };

async function compositeOverlay(
  heroBuf: Buffer,
  baseBuf: Buffer,
  bboxes: Bbox[],
  variant: 'OLD' | 'NEW',
): Promise<Buffer> {
  const heroMeta = await sharp(heroBuf).metadata();
  const W = heroMeta.width!;
  const H = heroMeta.height!;

  const sorted = [...bboxes].sort((a, b) => a.y - b.y);
  const clusters: Bbox[][] = [];
  let current: Bbox[] = [];
  let lastBottom = -Infinity;
  for (const b of sorted) {
    const gap = b.y - lastBottom;
    if (gap > 200 && current.length > 0) {
      clusters.push(current);
      current = [];
    }
    current.push(b);
    lastBottom = Math.max(lastBottom, b.y + b.height);
  }
  if (current.length > 0) clusters.push(current);

  const GROUP_PAD = 30;
  const NEAR_DIST = 14;
  const FAR_DIST = variant === 'OLD' ? 50 : 80;
  const CORNER_SAMPLE = 12;
  const ALPHA_BINARIZE_THRESHOLD = variant === 'OLD' ? null : 100; // OLD no binariza

  const composites: sharp.OverlayOptions[] = [];

  for (const group of clusters) {
    const ux = Math.min(...group.map((b) => b.x));
    const uy = Math.min(...group.map((b) => b.y));
    const ur = Math.max(...group.map((b) => b.x + b.width));
    const ub = Math.max(...group.map((b) => b.y + b.height));
    const left = Math.max(0, Math.round(ux - GROUP_PAD));
    const top = Math.max(0, Math.round(uy - GROUP_PAD));
    const right = Math.min(W, Math.round(ur + GROUP_PAD));
    const bottom = Math.min(H, Math.round(ub + GROUP_PAD));
    const cw = right - left;
    const ch = bottom - top;
    if (cw <= 0 || ch <= 0) continue;
    const cs = Math.min(CORNER_SAMPLE, Math.floor(Math.min(cw, ch) / 2));
    if (cs <= 0) continue;
    const cornerRects = [
      { left, top, width: cs, height: cs },
      { left: right - cs, top, width: cs, height: cs },
      { left, top: bottom - cs, width: cs, height: cs },
      { left: right - cs, top: bottom - cs, width: cs, height: cs },
    ];

    let bgR = 0, bgG = 0, bgB = 0;
    for (const c of cornerRects) {
      if (variant === 'OLD') {
        // Sharp bug: stats() devuelve stats de la fuente, no del extract
        const stats = await sharp(heroBuf).extract(c).stats();
        bgR += stats.channels[0].mean;
        bgG += stats.channels[1].mean;
        bgB += stats.channels[2].mean;
      } else {
        const cornerBuf = await sharp(heroBuf).extract(c).toBuffer();
        const stats = await sharp(cornerBuf).stats();
        bgR += stats.channels[0].mean;
        bgG += stats.channels[1].mean;
        bgB += stats.channels[2].mean;
      }
    }
    bgR /= 4; bgG /= 4; bgB /= 4;
    console.log(`  [${variant}] cluster ${left},${top} ${cw}x${ch} BG=(${bgR.toFixed(0)},${bgG.toFixed(0)},${bgB.toFixed(0)})`);

    const { data, info } = await sharp(heroBuf)
      .extract({ left, top, width: cw, height: ch })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const inCh = info.channels;
    const out = Buffer.alloc(cw * ch * 4);
    for (let i = 0; i < cw * ch; i++) {
      const idx = i * inCh;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const dist = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);
      let alpha: number;
      if (dist <= NEAR_DIST) alpha = 0;
      else if (dist >= FAR_DIST) alpha = 255;
      else alpha = Math.round(((dist - NEAR_DIST) / (FAR_DIST - NEAR_DIST)) * 255);
      if (ALPHA_BINARIZE_THRESHOLD !== null) {
        alpha = alpha >= ALPHA_BINARIZE_THRESHOLD ? 255 : 0;
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = alpha;
    }
    const patch = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
    composites.push({ input: patch, left, top });
  }

  if (composites.length === 0) return baseBuf;
  return await sharp(baseBuf).composite(composites).png().toBuffer();
}

async function main() {
  // Usar dimensiones nativas del hero (sin resize) y resize la base al
  // tamaño del hero. Asi los bboxes (que vienen en coords del hero) alinean
  // 1:1 sin escalar — replica produccion exactamente.
  const heroBuf = await sharp(readFileSync(HERO_PATH)).png().toBuffer();
  const heroMeta = await sharp(heroBuf).metadata();
  const W = heroMeta.width!;
  const H = heroMeta.height!;
  console.log(`hero size: ${W}x${H}`);
  const baseBuf = await sharp(readFileSync(RAW_PATH)).resize(W, H, { fit: 'cover' }).png().toBuffer();

  for (const variant of ['OLD', 'NEW'] as const) {
    console.log(`\n=== ${variant} ===`);
    const result = await compositeOverlay(heroBuf, baseBuf, REAL_BBOXES, variant);
    const out = `${OUT_DIR}/result_${variant}_native.png`;
    writeFileSync(out, result);
    console.log(`saved ${out}`);
  }
}
main().catch((err) => { console.error(err); process.exit(1); });

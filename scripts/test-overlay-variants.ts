/**
 * Test las 3 variantes del fix de compositeHeroOverlays SIN tocar prod code.
 *
 * Input:
 *  - hero original (sabana polar gris con panel + logo + badge)
 *  - imagen Gemini "limpia" generada en sample anterior (V5_pro_clean_3)
 *  - text bboxes del Job A (extraidos de prompt_metadata.text_elements_detected)
 *
 * Variantes:
 *  V_CURRENT — codigo actual (con bug)
 *  V_A — revert: cluster como rectangulo opaco (sin chroma-key)
 *  V_B — variance check: chroma-key solo si BG sample es uniforme
 *  V_C — GROUP_PAD = 5 (en vez de 30)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

const HERO_PATH = '/tmp/hero_smudge.png';
const GEMINI_OUTPUT_PATH = '/tmp/hero_review/ablation/V5_pro_clean_3.png';
const OUT_DIR = '/tmp/hero_review/overlay_variants';
mkdirSync(OUT_DIR, { recursive: true });

// Bboxes detectadas en el hero — copiadas de prompt_metadata.text_elements_detected
// del Job 13396077 (Job B, mismo hero). Position labels (top/center/bottom) se
// convierten a Y aproximado abajo. En produccion vienen del text-element-analyzer
// con pixel coords reales — para este test reproducimos a partir de inspeccion
// visual del hero (1080x1080):
type Bbox = { x: number; y: number; width: number; height: number };

// Inspeccion visual del hero (estimado en 1080x1080):
// - Logo "AF AMERICAN FAMILY" arriba izquierda: aprox (40, 30) a (200, 150)
// - Titulo "Instrucciones de lavado" arriba derecha: (550, 50) a (1000, 180)
// - Iconos panel + texto "Lavar a maquina..." etc: 5 filas en panel derecho
// - Badge "Sabanas polar 100% poliester" abajo izquierda: (50, 940) a (320, 1030)
const HERO_BBOXES: Bbox[] = [
  // Logo block top-left
  { x: 40, y: 28, width: 32, height: 38 },     // AF logo box
  { x: 38, y: 80, width: 122, height: 16 },    // AMERICAN
  { x: 38, y: 100, width: 90, height: 16 },    // FAMILY

  // Title top-right
  { x: 552, y: 60, width: 360, height: 40 },   // Instrucciones
  { x: 552, y: 105, width: 220, height: 40 },  // de lavado

  // Panel rows (icon labels)
  { x: 540, y: 220, width: 80, height: 80 },   // icon 1
  { x: 660, y: 240, width: 200, height: 36 },  // text 1
  { x: 540, y: 350, width: 80, height: 80 },   // icon 2
  { x: 660, y: 370, width: 200, height: 36 },  // text 2
  { x: 540, y: 480, width: 80, height: 80 },   // icon 3
  { x: 660, y: 500, width: 280, height: 36 },  // text 3
  { x: 540, y: 620, width: 80, height: 80 },   // icon 4
  { x: 660, y: 640, width: 280, height: 36 },  // text 4
  { x: 540, y: 760, width: 80, height: 80 },   // icon 5
  { x: 660, y: 780, width: 280, height: 36 },  // text 5

  // Badge bottom-left — ESTE es el problematico
  { x: 50, y: 945, width: 270, height: 90 },   // Sabanas polar badge
];

// Helper: calcula varianza de un buffer raw (cw*ch*4)
function bufferVariance(data: Buffer, cw: number, ch: number): number {
  let sumR = 0, sumG = 0, sumB = 0;
  let n = 0;
  for (let i = 0; i < cw * ch; i++) {
    sumR += data[i * 3];
    sumG += data[i * 3 + 1];
    sumB += data[i * 3 + 2];
    n++;
  }
  const mR = sumR / n, mG = sumG / n, mB = sumB / n;
  let varR = 0, varG = 0, varB = 0;
  for (let i = 0; i < cw * ch; i++) {
    varR += (data[i * 3] - mR) ** 2;
    varG += (data[i * 3 + 1] - mG) ** 2;
    varB += (data[i * 3 + 2] - mB) ** 2;
  }
  return Math.sqrt((varR + varG + varB) / (3 * n));
}

type Variant = 'CURRENT' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

async function compositeOverlay(
  heroBuf: Buffer,
  baseBuf: Buffer,
  bboxes: Bbox[],
  variant: Variant,
): Promise<Buffer> {
  const heroMeta = await sharp(heroBuf).metadata();
  const W = heroMeta.width!;
  const H = heroMeta.height!;

  // Cluster por proximidad Y, y para variant D tambien por X. Bajamos el gap
  // a 100 para reflejar mejor el caso real (3 clusters: logo top-left,
  // panel-derecha, badge-abajo-izquierda).
  const CLUSTER_GAP = 100;
  let clusters: Bbox[][];
  if (variant === 'D' || variant === 'E' || variant === 'F') {
    // Cluster 2D: union-find por proximidad X+Y. Si gap entre 2 bboxes en
    // ambos ejes < 100 → mismo cluster.
    const parent: number[] = bboxes.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        const a = bboxes[i], b = bboxes[j];
        const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
        const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
        if (dx < CLUSTER_GAP && dy < CLUSTER_GAP) union(i, j);
      }
    }
    const groups = new Map<number, Bbox[]>();
    bboxes.forEach((bb, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(bb);
    });
    clusters = Array.from(groups.values());
  } else {
    const sorted = [...bboxes].sort((a, b) => a.y - b.y);
    clusters = [];
    let current: Bbox[] = [];
    let lastBottom = -Infinity;
    for (const b of sorted) {
      const gap = b.y - lastBottom;
      if (gap > CLUSTER_GAP && current.length > 0) {
        clusters.push(current);
        current = [];
      }
      current.push(b);
      lastBottom = Math.max(lastBottom, b.y + b.height);
    }
    if (current.length > 0) clusters.push(current);
  }

  const GROUP_PAD = variant === 'C' ? 5 : 30;
  const NEAR_DIST = 14;
  const FAR_DIST = 80;
  const CORNER_SAMPLE = 12;
  const ALPHA_BINARIZE_THRESHOLD = 100;
  const VARIANCE_TEXTURED_THRESHOLD = 25; // for variant B

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
    let maxCornerVariance = 0;
    for (const c of cornerRects) {
      const cornerBuf = await sharp(heroBuf).extract(c).toBuffer();
      const stats = await sharp(cornerBuf).stats();
      bgR += stats.channels[0].mean;
      bgG += stats.channels[1].mean;
      bgB += stats.channels[2].mean;
      // Variant B: medir varianza por canal (stdev)
      const cornerVar = (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;
      maxCornerVariance = Math.max(maxCornerVariance, cornerVar);
    }
    bgR /= 4; bgG /= 4; bgB /= 4;

    // Variant A: pegar el cluster como rectangulo opaco SIN chroma-key
    if (variant === 'A') {
      const opaque = await sharp(heroBuf)
        .extract({ left, top, width: cw, height: ch })
        .png()
        .toBuffer();
      composites.push({ input: opaque, left, top });
      console.log(`  [A] cluster ${left},${top} ${cw}x${ch} → opaque rect`);
      continue;
    }

    // Variant B: si BG sample tiene mucha varianza (tela texturada), pegar opaco
    if (variant === 'B' && maxCornerVariance > VARIANCE_TEXTURED_THRESHOLD) {
      const opaque = await sharp(heroBuf)
        .extract({ left, top, width: cw, height: ch })
        .png()
        .toBuffer();
      composites.push({ input: opaque, left, top });
      console.log(`  [B] cluster ${left},${top} cornerVar=${maxCornerVariance.toFixed(1)} > ${VARIANCE_TEXTURED_THRESHOLD} → opaque rect`);
      continue;
    }

    // Variant F: bbox individual SIN chroma-key, pegado como rect opaco.
    // Cada bbox es chico (icono o texto) — el rect blanco resultante no oculta
    // mucha sabana, y elimina la fragility del chroma-key con noise pixel.
    if (variant === 'F') {
      for (const bb of group) {
        const opaque = await sharp(heroBuf)
          .extract({
            left: Math.round(bb.x),
            top: Math.round(bb.y),
            width: Math.round(bb.width),
            height: Math.round(bb.height),
          })
          .png()
          .toBuffer();
        composites.push({ input: opaque, left: Math.round(bb.x), top: Math.round(bb.y) });
      }
      console.log(`  [F] cluster ${left},${top} → ${group.length} individual opaque bboxes`);
      continue;
    }

    // Variant D/E: usa BG del cluster expandido pero compone solo sobre los
    // bboxes INDIVIDUALES — evita incluir tela del hero.
    //  D: padding 8 (deja un margen ~ leve halo)
    //  E: padding 0 (bbox exacto, no toca bordes del panel)
    if (variant === 'D' || variant === 'E') {
      const INDIVIDUAL_PAD = variant === 'E' ? 0 : 8;
      for (const bb of group) {
        const bl = Math.max(0, Math.round(bb.x - INDIVIDUAL_PAD));
        const bt = Math.max(0, Math.round(bb.y - INDIVIDUAL_PAD));
        const br = Math.min(W, Math.round(bb.x + bb.width + INDIVIDUAL_PAD));
        const bb2 = Math.min(H, Math.round(bb.y + bb.height + INDIVIDUAL_PAD));
        const bw = br - bl;
        const bh = bb2 - bt;
        if (bw <= 0 || bh <= 0) continue;
        const { data, info } = await sharp(heroBuf)
          .extract({ left: bl, top: bt, width: bw, height: bh })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const inCh = info.channels;
        const out = Buffer.alloc(bw * bh * 4);
        for (let i = 0; i < bw * bh; i++) {
          const idx = i * inCh;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const dr = r - bgR;
          const dg = g - bgG;
          const db = b - bgB;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          let alpha: number;
          if (dist <= NEAR_DIST) alpha = 0;
          else if (dist >= FAR_DIST) alpha = 255;
          else alpha = Math.round(((dist - NEAR_DIST) / (FAR_DIST - NEAR_DIST)) * 255);
          alpha = alpha >= ALPHA_BINARIZE_THRESHOLD ? 255 : 0;
          out[i * 4] = r;
          out[i * 4 + 1] = g;
          out[i * 4 + 2] = b;
          out[i * 4 + 3] = alpha;
        }
        const patch = await sharp(out, { raw: { width: bw, height: bh, channels: 4 } }).png().toBuffer();
        composites.push({ input: patch, left: bl, top: bt });
      }
      console.log(`  [D] cluster ${left},${top} BG=(${bgR.toFixed(0)},${bgG.toFixed(0)},${bgB.toFixed(0)}) → ${group.length} individual bbox composites`);
      continue;
    }

    // CURRENT y C: chroma-key normal
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
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      let alpha: number;
      if (dist <= NEAR_DIST) alpha = 0;
      else if (dist >= FAR_DIST) alpha = 255;
      else alpha = Math.round(((dist - NEAR_DIST) / (FAR_DIST - NEAR_DIST)) * 255);
      alpha = alpha >= ALPHA_BINARIZE_THRESHOLD ? 255 : 0;
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = alpha;
    }
    const patch = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
    composites.push({ input: patch, left, top });
    const tag = variant === 'C' ? 'C(pad5)' : 'CURRENT';
    console.log(`  [${tag}] cluster ${left},${top} ${cw}x${ch} chroma-key, cornerVar=${maxCornerVariance.toFixed(1)}`);
  }

  if (composites.length === 0) return baseBuf;
  return await sharp(baseBuf).composite(composites).png().toBuffer();
}

async function main() {
  const heroBuf = await sharp(readFileSync(HERO_PATH)).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();
  const baseBuf = await sharp(readFileSync(GEMINI_OUTPUT_PATH)).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();

  for (const variant of ['CURRENT', 'D', 'E', 'F'] as Variant[]) {
    console.log(`\n=== Variant ${variant} ===`);
    const result = await compositeOverlay(heroBuf, baseBuf, HERO_BBOXES, variant);
    const out = `${OUT_DIR}/result_${variant}.png`;
    writeFileSync(out, result);
    console.log(`saved ${out}`);
  }

  console.log('\nDone. Compare:');
  console.log(`  open ${OUT_DIR}/result_CURRENT.png ${OUT_DIR}/result_A.png ${OUT_DIR}/result_B.png ${OUT_DIR}/result_C.png`);
}

main().catch((err) => { console.error(err); process.exit(1); });

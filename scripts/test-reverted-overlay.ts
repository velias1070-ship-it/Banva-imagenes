/**
 * Aplica el compositeHeroOverlays REVERTIDO (codigo del 30/4) sobre la
 * misma base limpia (V5_pro_clean_3) + hero, con los mismos bboxes que
 * el test-overlay-variants. El resultado deberia ser equivalente al
 * comportamiento del Job B (clean).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { compositeHeroOverlays } from '../src/lib/image-processing';

const HERO_PATH = '/tmp/hero_smudge.png';
const BASE_PATH = '/tmp/hero_review/ablation/V5_pro_clean_3.png';
const OUT_DIR = '/tmp/hero_review/overlay_variants';
mkdirSync(OUT_DIR, { recursive: true });

const HERO_BBOXES = [
  { x: 40, y: 28, width: 32, height: 38 },
  { x: 38, y: 80, width: 122, height: 16 },
  { x: 38, y: 100, width: 90, height: 16 },
  { x: 552, y: 60, width: 360, height: 40 },
  { x: 552, y: 105, width: 220, height: 40 },
  { x: 540, y: 220, width: 80, height: 80 },
  { x: 660, y: 240, width: 200, height: 36 },
  { x: 540, y: 350, width: 80, height: 80 },
  { x: 660, y: 370, width: 200, height: 36 },
  { x: 540, y: 480, width: 80, height: 80 },
  { x: 660, y: 500, width: 280, height: 36 },
  { x: 540, y: 620, width: 80, height: 80 },
  { x: 660, y: 640, width: 280, height: 36 },
  { x: 540, y: 760, width: 80, height: 80 },
  { x: 660, y: 780, width: 280, height: 36 },
  { x: 50, y: 945, width: 270, height: 90 },
];

async function main() {
  const heroBuf = await sharp(readFileSync(HERO_PATH)).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();
  const baseBuf = await sharp(readFileSync(BASE_PATH)).resize(1080, 1080, { fit: 'cover' }).png().toBuffer();
  const result = await compositeHeroOverlays(heroBuf, baseBuf, HERO_BBOXES);
  const out = `${OUT_DIR}/result_REVERTED.png`;
  writeFileSync(out, result);
  console.log(`saved ${out}`);
}
main().catch((err) => { console.error(err); process.exit(1); });

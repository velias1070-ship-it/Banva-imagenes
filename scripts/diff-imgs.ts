import sharp from 'sharp';
import { readFileSync } from 'node:fs';

async function diff(a: string, b: string) {
  const aBuf = await sharp(readFileSync(a)).raw().toBuffer({ resolveWithObject: true });
  const bBuf = await sharp(readFileSync(b)).resize(aBuf.info.width, aBuf.info.height).raw().toBuffer({ resolveWithObject: true });
  let totalDiff = 0;
  let maxDiff = 0;
  let pixelsWithBigDiff = 0;
  const aD = aBuf.data, bD = bBuf.data;
  const ch = aBuf.info.channels;
  const px = aBuf.info.width * aBuf.info.height;
  for (let i = 0; i < aD.length; i += ch) {
    const d = Math.abs(aD[i] - bD[i]) + Math.abs(aD[i+1] - bD[i+1]) + Math.abs(aD[i+2] - bD[i+2]);
    totalDiff += d;
    maxDiff = Math.max(maxDiff, d);
    if (d > 50) pixelsWithBigDiff++;
  }
  const aName = a.split('/').pop();
  const bName = b.split('/').pop();
  console.log(`${aName} vs ${bName}: avgDiff=${(totalDiff/px).toFixed(2)}/765 maxDiff=${maxDiff} bigDiffPixels=${pixelsWithBigDiff} (${(100*pixelsWithBigDiff/px).toFixed(2)}%) size=${aBuf.info.width}x${aBuf.info.height}`);
}

async function main() {
  await diff('/tmp/hero_review/routing_fix/sample_1_raw_flash02.png', '/tmp/hero_review/jobB_canonical.png');
  await diff('/tmp/hero_review/jobB_canonical.png', '/tmp/hero_review/jobB_final.png');
  await diff('/tmp/hero_review/routing_fix/sample_1_raw_flash02.png', '/tmp/hero_review/routing_fix/sample_1_final.png');
  await diff('/tmp/hero_review/old_vs_new/result_OLD.png', '/tmp/hero_review/old_vs_new/result_NEW.png');
}
main();

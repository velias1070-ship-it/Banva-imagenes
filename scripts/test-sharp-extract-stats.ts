import sharp from 'sharp';
import { readFileSync } from 'node:fs';

async function main() {
  const heroBuf = await sharp(readFileSync('/tmp/hero_smudge.png'))
    .resize(1080, 1080, { fit: 'cover' })
    .png()
    .toBuffer();

  console.log('Image size:', (await sharp(heroBuf).metadata()).width, 'x', (await sharp(heroBuf).metadata()).height);

  // Method 1: .extract().stats() — el "bug" que afecto codigo del 30/4
  console.log('\n=== Method 1: sharp(buf).extract(c).stats() ===');
  for (const c of [
    { left: 0, top: 0, width: 12, height: 12 },                     // top-left corner
    { left: 1068, top: 0, width: 12, height: 12 },                  // top-right corner
    { left: 0, top: 1068, width: 12, height: 12 },                  // bottom-left
    { left: 540, top: 540, width: 12, height: 12 },                 // center
  ]) {
    const stats = await sharp(heroBuf).extract(c).stats();
    console.log(`corner ${c.left},${c.top}: R=${stats.channels[0].mean.toFixed(0)} G=${stats.channels[1].mean.toFixed(0)} B=${stats.channels[2].mean.toFixed(0)}`);
  }

  // Method 2: materialize first
  console.log('\n=== Method 2: sharp(buf).extract(c).toBuffer() then sharp(buf).stats() ===');
  for (const c of [
    { left: 0, top: 0, width: 12, height: 12 },
    { left: 1068, top: 0, width: 12, height: 12 },
    { left: 0, top: 1068, width: 12, height: 12 },
    { left: 540, top: 540, width: 12, height: 12 },
  ]) {
    const cornerBuf = await sharp(heroBuf).extract(c).toBuffer();
    const stats = await sharp(cornerBuf).stats();
    console.log(`corner ${c.left},${c.top}: R=${stats.channels[0].mean.toFixed(0)} G=${stats.channels[1].mean.toFixed(0)} B=${stats.channels[2].mean.toFixed(0)}`);
  }

  // Method 3: stats of full image
  console.log('\n=== Method 3: full image stats ===');
  const fullStats = await sharp(heroBuf).stats();
  console.log(`full: R=${fullStats.channels[0].mean.toFixed(0)} G=${fullStats.channels[1].mean.toFixed(0)} B=${fullStats.channels[2].mean.toFixed(0)}`);
}

main();

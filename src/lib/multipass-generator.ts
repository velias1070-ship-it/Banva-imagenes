import sharp from 'sharp';
import { generateImage } from '@/lib/gemini/client';
import { detectSwatchZones } from '@/lib/swatch-zone-detector';

export interface MultiPassResult {
  success: boolean;
  imageBuffer: Buffer | null;
  passes: number;
  error?: string;
}

/**
 * Multi-pass generation for sabanas: generates pillowcases and sheets separately.
 * Pass 1: Change only pillowcases using pillowcase zone from swatch
 * Pass 2: Change only sheets using sheet zone from swatch (on top of pass 1 result)
 */
export async function generateSabanasMultiPass(
  heroBase64: string,
  heroMimeType: string,
  swatchBase64: string,
  swatchMimeType: string,
  swatchBuffer: Buffer,
  temperature: number,
  useProModel: boolean,
): Promise<MultiPassResult> {
  // Step 1: Detect zones in swatch
  const metadata = await sharp(swatchBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  console.log(`[multipass] Detecting swatch zones (${width}x${height})...`);
  const zones = await detectSwatchZones(swatchBase64, swatchMimeType, width, height);

  if (!zones || (!zones.pillowcase && !zones.sheet)) {
    console.log('[multipass] Zone detection failed — falling back to single-pass');
    return { success: false, imageBuffer: null, passes: 0, error: 'Zone detection failed' };
  }

  let currentBase64 = heroBase64;
  let currentMimeType = heroMimeType;
  let passes = 0;

  // Pass 1: Pillowcases
  if (zones.pillowcase) {
    console.log(`[multipass] Pass 1: Pillowcases (crop: ${JSON.stringify(zones.pillowcase)})`);
    const pillowCrop = await sharp(swatchBuffer)
      .extract({
        left: Math.max(0, zones.pillowcase.left),
        top: Math.max(0, zones.pillowcase.top),
        width: Math.min(zones.pillowcase.width, width - zones.pillowcase.left),
        height: Math.min(zones.pillowcase.height, height - zones.pillowcase.top),
      })
      .resize(800, 800, { fit: 'cover' })
      .png()
      .toBuffer();

    const pass1 = await generateImage({
      heroImageBase64: currentBase64,
      heroMimeType: currentMimeType,
      swatchImageBase64: pillowCrop.toString('base64'),
      swatchMimeType: 'image/png',
      promptText: `Change ONLY the PILLOWCASES in Image 1 to match the fabric pattern in Image 2.
DO NOT change the sheets, fitted sheet, or any other textile — ONLY the pillowcases.
DO NOT change non-textile elements (walls, furniture, floor, lamp, headboard).
Keep the exact same composition, camera angle, and lighting.
The pillowcase pattern must match Image 2 EXACTLY — same texture, same stripes, same colors.`,
      temperature,
      useProModel,
    });

    if (pass1.success && pass1.imageBase64) {
      currentBase64 = pass1.imageBase64;
      currentMimeType = 'image/png';
      passes++;
      console.log(`[multipass] Pass 1 done — pillowcases changed`);
    } else {
      console.error(`[multipass] Pass 1 failed: ${pass1.error}`);
      return { success: false, imageBuffer: null, passes, error: `Pass 1 failed: ${pass1.error}` };
    }
  }

  // Pass 2: Sheets
  if (zones.sheet) {
    console.log(`[multipass] Pass 2: Sheets (crop: ${JSON.stringify(zones.sheet)})`);
    const sheetCrop = await sharp(swatchBuffer)
      .extract({
        left: Math.max(0, zones.sheet.left),
        top: Math.max(0, zones.sheet.top),
        width: Math.min(zones.sheet.width, width - zones.sheet.left),
        height: Math.min(zones.sheet.height, height - zones.sheet.top),
      })
      .resize(800, 800, { fit: 'cover' })
      .png()
      .toBuffer();

    const pass2 = await generateImage({
      heroImageBase64: currentBase64,
      heroMimeType: currentMimeType,
      swatchImageBase64: sheetCrop.toString('base64'),
      swatchMimeType: 'image/png',
      promptText: `Change ONLY the SHEETS (sabanas) in Image 1 to match the fabric pattern in Image 2.
DO NOT change the pillowcases — they are already correct, leave them EXACTLY as they are.
DO NOT change non-textile elements (walls, furniture, floor, lamp, headboard).
Keep the exact same composition, camera angle, and lighting.
The sheet pattern must match Image 2 EXACTLY — same texture, same pattern, same colors.`,
      temperature,
      useProModel,
    });

    if (pass2.success && pass2.imageBase64) {
      currentBase64 = pass2.imageBase64;
      passes++;
      console.log(`[multipass] Pass 2 done — sheets changed`);
    } else {
      console.error(`[multipass] Pass 2 failed: ${pass2.error}`);
      // Return pass 1 result if pass 2 fails (pillowcases are correct at least)
      return {
        success: true,
        imageBuffer: Buffer.from(currentBase64, 'base64'),
        passes,
        error: `Pass 2 failed (using pass 1 result): ${pass2.error}`,
      };
    }
  }

  return {
    success: true,
    imageBuffer: Buffer.from(currentBase64, 'base64'),
    passes,
  };
}

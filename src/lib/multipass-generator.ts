import sharp from 'sharp';
import { generateImage } from '@/lib/gemini/client';

export interface MultiPassResult {
  success: boolean;
  imageBuffer: Buffer | null;
  passes: number;
  error?: string;
}

/**
 * Multi-pass generation for sabanas: generates pillowcases and sheets separately.
 * Pass 1: Change only pillowcases using top zone of swatch (where pillowcases are)
 * Pass 2: Change only sheets using bottom zone of swatch (where sheets are)
 *
 * Uses heuristic crop (no AI zone detection) to fit within 60s Vercel timeout.
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
  const metadata = await sharp(swatchBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  // Heuristic zones: pillowcases = top 45%, sheets = bottom 60% (overlap is intentional)
  const pillowCrop = await sharp(swatchBuffer)
    .extract({ left: 0, top: 0, width, height: Math.round(height * 0.45) })
    .resize(800, 800, { fit: 'cover' })
    .png()
    .toBuffer();

  const sheetCrop = await sharp(swatchBuffer)
    .extract({ left: 0, top: Math.round(height * 0.35), width, height: Math.round(height * 0.65) })
    .resize(800, 800, { fit: 'cover' })
    .png()
    .toBuffer();

  let currentBase64 = heroBase64;
  let currentMimeType = heroMimeType;
  let passes = 0;

  // Pass 1: Pillowcases only
  console.log(`[multipass] Pass 1: Pillowcases (top 45% of swatch, ${width}x${height})`);
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

  // Pass 2: Sheets only (preserve pillowcases from pass 1)
  console.log(`[multipass] Pass 2: Sheets (bottom 65% of swatch)`);
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
    return {
      success: true,
      imageBuffer: Buffer.from(currentBase64, 'base64'),
      passes,
      error: `Pass 2 failed (using pass 1 result): ${pass2.error}`,
    };
  }

  return {
    success: true,
    imageBuffer: Buffer.from(currentBase64, 'base64'),
    passes,
  };
}

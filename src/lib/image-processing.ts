import sharp from 'sharp';

const DARK_SWATCH_THRESHOLD = 115; // brightness 0-255 — swatch images include context (pillows, bg) that raise the average

/**
 * Analyze average brightness of an image.
 * Returns value 0-255 where 0=black, 255=white.
 */
export async function getAverageBrightness(imageBuffer: Buffer): Promise<number> {
  const stats = await sharp(imageBuffer).stats();
  // Average across R, G, B channels
  const avgBrightness = stats.channels
    .slice(0, 3) // Only RGB, skip alpha if present
    .reduce((sum, ch) => sum + ch.mean, 0) / Math.min(stats.channels.length, 3);
  return avgBrightness;
}

/**
 * Check if a swatch is "dark" (pattern hard to see).
 */
export async function isSwatchDark(imageBuffer: Buffer): Promise<boolean> {
  const brightness = await getAverageBrightness(imageBuffer);
  console.log(`[image-processing] Swatch brightness: ${brightness.toFixed(1)} / 255 (threshold: ${DARK_SWATCH_THRESHOLD})`);
  return brightness < DARK_SWATCH_THRESHOLD;
}

/**
 * Enhance contrast of a dark swatch to make its pattern visible.
 * Uses grayscale + CLAHE (adaptive histogram equalization) for maximum local contrast.
 * The output is NOT color-accurate — it's only for pattern/texture reference.
 * NOTE: DEPRECATED — do NOT use as Image 2 replacement. See errors-resolved.md #5.
 */
export async function enhanceSwatchContrast(imageBuffer: Buffer): Promise<Buffer> {
  const enhanced = await sharp(imageBuffer)
    .grayscale()                          // Remove color noise — focus on texture
    .clahe({ width: 8, height: 8, maxSlope: 5 })  // CLAHE: local contrast enhancement, ideal for subtle textures
    .normalize()                          // Stretch histogram to full 0-255 range
    .linear(2.0, 0)                       // Additional global contrast boost
    .sharpen({ sigma: 2.0 })             // Sharpen to make stitching/quilting lines pop
    .toBuffer();

  console.log('[image-processing] Created CLAHE-enhanced swatch (grayscale + local contrast)');
  return enhanced;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quilt Preprocessing — Tier 1 (swatch crop + hero flatten)
// Validated 2026-03-06 on "Quilt roma 2" project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a category needs quilt-specific preprocessing.
 * @deprecated Use getCategoryStrategy(category).preprocessing.crop_swatch instead.
 * Kept for backward compatibility during migration.
 */
export function needsQuiltPreprocessing(category: string): boolean {
  return category.toLowerCase().includes('quilt');
}

/**
 * Crop a swatch image to its central fabric zone.
 * When a swatch is a full lifestyle photo (bedroom scene), this extracts just
 * the quilt fabric area, avoiding furniture, walls, and background.
 *
 * Crop zone: y 40%-75% of height, x 10%-90% of width
 * Output: 800x800 square (Gemini prefers square input)
 */
export async function cropSwatchToFabric(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  // Central fabric zone — avoids top (headboard/pillows) and bottom (bed frame/floor)
  const cropLeft = Math.round(width * 0.10);
  const cropTop = Math.round(height * 0.40);
  const cropWidth = Math.round(width * 0.80);   // 10% to 90%
  const cropHeight = Math.round(height * 0.35);  // 40% to 75%

  const cropped = await sharp(imageBuffer)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, width - cropLeft),
      height: Math.min(cropHeight, height - cropTop),
    })
    .resize(800, 800, { fit: 'cover' })
    .toBuffer();

  console.log(`[image-processing] Cropped swatch to fabric zone: ${cropWidth}x${cropHeight} -> 800x800`);
  return cropped;
}

/**
 * Flatten embossed quilting texture in a hero image.
 * Reduces deep shadow channels that Gemini interprets as fixed geometry,
 * allowing it to replace the quilting stitch pattern.
 *
 * V3 — Very aggressive: blur 5.0 + contrast 0.50 + re-sharpen scene edges.
 * The high blur destroys emboss texture, then selective sharpen restores
 * scene clarity (model, furniture, text) without reviving the emboss.
 *
 * IMPORTANT: Only modify the HERO (Image 1). Never the swatch.
 */
export async function flattenHeroEmboss(imageBuffer: Buffer): Promise<Buffer> {
  // Step 1: Resize + aggressively lift darks — maps 0->80, 255->255
  //         a = (255 - 80) / 255 = 0.686, b = 80
  const lifted = await sharp(imageBuffer)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .linear(0.686, 80)
    .toBuffer();

  // Step 2: Heavy gaussian blur (5.0) to destroy embossed relief texture
  const blurred = await sharp(lifted)
    .blur(5.0)
    .toBuffer();

  // Step 3: Reduce contrast — linear(0.50, 64) compresses range to 50%
  //         64 = 255 * (1 - 0.50) / 2
  const flattened = await sharp(blurred)
    .linear(0.50, 64)
    .toBuffer();

  // Step 4: Re-sharpen scene edges (model, furniture, text) without reviving emboss
  //         Low sigma (1.0) only sharpens broad edges, not fine texture
  const sharpened = await sharp(flattened)
    .sharpen({ sigma: 1.0, m1: 1.5, m2: 0.5 })
    .toBuffer();

  console.log('[image-processing] Flattened hero emboss V3: lift 0->80 + blur 5.0 + contrast 0.50 + re-sharpen');
  return sharpened;
}

/**
 * Post-process generated image to meet MercadoLibre specs:
 * - Exact resolution: sizePx x sizePx (default 1200x1200)
 * - Color space: sRGB (converts from CMYK if needed)
 * - Format: PNG buffer
 */
export async function ensureOutputSpec(imageBuffer: Buffer, sizePx: number = 1200): Promise<Buffer> {
  const processed = await sharp(imageBuffer)
    .toColorspace('srgb')
    .resize(sizePx, sizePx, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
    })
    .png()
    .toBuffer();

  console.log(`[image-processing] Post-processed to ${sizePx}x${sizePx} sRGB PNG`);
  return processed;
}

/**
 * Combine multiple swatch reference images into a single collage.
 * Gemini only accepts 2 images (hero + swatch), so multiple swatch
 * references are stitched into one composite image.
 *
 * Layout: horizontal strip if 2-3 images, 2x2 grid if 4.
 * Output: 1200x1200 square.
 */
export async function createSwatchCollage(imageBuffers: Buffer[]): Promise<Buffer> {
  if (imageBuffers.length === 0) throw new Error('No images to collage');
  if (imageBuffers.length === 1) return imageBuffers[0];

  const targetSize = 1200;
  const count = Math.min(imageBuffers.length, 4); // Max 4 images in collage

  let cellWidth: number;
  let cellHeight: number;
  let cols: number;
  let rows: number;

  if (count <= 2) {
    // Side by side
    cols = 2; rows = 1;
    cellWidth = targetSize / 2;
    cellHeight = targetSize;
  } else if (count === 3) {
    // 1 large left + 2 stacked right
    cols = 2; rows = 2;
    cellWidth = targetSize / 2;
    cellHeight = targetSize / 2;
  } else {
    // 2x2 grid
    cols = 2; rows = 2;
    cellWidth = targetSize / 2;
    cellHeight = targetSize / 2;
  }

  // Resize each image to fit its cell
  const resizedBuffers: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const resized = await sharp(imageBuffers[i])
      .resize(Math.round(cellWidth), Math.round(cellHeight), {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255 },
      })
      .png()
      .toBuffer();
    resizedBuffers.push(resized);
  }

  // Special case: 3 images → first image takes full left column
  if (count === 3) {
    const largeLeft = await sharp(imageBuffers[0])
      .resize(Math.round(targetSize / 2), targetSize, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255 },
      })
      .png()
      .toBuffer();

    const collage = await sharp({
      create: {
        width: targetSize,
        height: targetSize,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        { input: largeLeft, left: 0, top: 0 },
        { input: resizedBuffers[1], left: Math.round(targetSize / 2), top: 0 },
        { input: resizedBuffers[2], left: Math.round(targetSize / 2), top: Math.round(targetSize / 2) },
      ])
      .png()
      .toBuffer();

    console.log(`[image-processing] Created swatch collage: 3 images (1 large + 2 small)`);
    return collage;
  }

  // General grid layout (2 or 4 images)
  const composites = resizedBuffers.map((buf, i) => ({
    input: buf,
    left: Math.round((i % cols) * cellWidth),
    top: Math.round(Math.floor(i / cols) * cellHeight),
  }));

  const collage = await sharp({
    create: {
      width: targetSize,
      height: targetSize,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  console.log(`[image-processing] Created swatch collage: ${count} images in ${cols}x${rows} grid`);
  return collage;
}

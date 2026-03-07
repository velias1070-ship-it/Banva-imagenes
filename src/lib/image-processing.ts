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
 * Process: lift darks (0->40) + gaussian blur (1.5) + reduce contrast (0.75)
 * Validated on PIL equivalent: img.point(lambda p: int(p * 0.843 + 40))
 *
 * IMPORTANT: Only modify the HERO (Image 1). Never the swatch.
 */
export async function flattenHeroEmboss(imageBuffer: Buffer): Promise<Buffer> {
  // Step 1: Resize if too large
  // Step 2: Lift darks — linear(a=0.843, b=40) maps 0->40, 255->255
  //         This reduces shadow depth in embossed quilting channels
  const lifted = await sharp(imageBuffer)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .linear(0.843, 40)
    .toBuffer();

  // Step 3: Gaussian blur to soften embossed edge transitions
  const blurred = await sharp(lifted)
    .blur(1.5)
    .toBuffer();

  // Step 4: Reduce contrast — linear(a=0.75, b=32) brings highlights/shadows closer
  //         32 = 255 * (1 - 0.75) / 2, centers the midpoint
  const flattened = await sharp(blurred)
    .linear(0.75, 32)
    .toBuffer();

  console.log('[image-processing] Flattened hero emboss: lift darks + blur 1.5 + contrast 0.75');
  return flattened;
}

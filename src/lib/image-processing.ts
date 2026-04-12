import sharp from 'sharp';

const DARK_SWATCH_THRESHOLD = 115; // brightness 0-255 — swatch images include context (pillows, bg) that raise the average

/**
 * Get the dominant color of an image as RGB values.
 *
 * Uses a saturation-aware approach: filters out near-white, near-black,
 * and near-grey pixels, then averages the remaining "colorful" pixels.
 * This avoids the muddy mean that .stats() returns when an image has lots
 * of white background mixed with the actual color.
 *
 * Falls back to channel mean if no saturated pixels found.
 */
export async function getDominantColor(imageBuffer: Buffer): Promise<{ r: number; g: number; b: number }> {
  // Resize to a small thumbnail for fast analysis
  const { data, info } = await sharp(imageBuffer)
    .resize(150, 150, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let sumR = 0, sumG = 0, sumB = 0, count = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Compute saturation (HSL): max-min / max if max>0
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const brightness = max;

    // Skip pixels that are: too dark (text/shadow), too light (white bg), or too desaturated (grey)
    if (brightness < 40 || brightness > 240) continue;
    if (saturation < 0.25) continue;

    sumR += r;
    sumG += g;
    sumB += b;
    count++;
  }

  if (count === 0) {
    // Fallback: use simple mean
    const stats = await sharp(imageBuffer).stats();
    return {
      r: Math.round(stats.channels[0]?.mean ?? 200),
      g: Math.round(stats.channels[1]?.mean ?? 200),
      b: Math.round(stats.channels[2]?.mean ?? 200),
    };
  }

  return {
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
  };
}

/**
 * Parse a hex color string (#RRGGBB) to RGB.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * Map a Spanish color name to a saturated hex color.
 * Used as a high-confidence fallback when Gemini's swatch analysis returns
 * confusing results (e.g., for full-product swatches with lots of background).
 *
 * Returns null if the name doesn't match any known color.
 */
export function colorNameToHex(name: string): string | null {
  const normalized = name.toLowerCase().trim().replace(/\s+/g, ' ');

  // Map of common Spanish color names → saturated hex
  const map: Record<string, string> = {
    // Yellows
    'amarillo': '#F5D830',
    'amarillo claro': '#FFEE58',
    'amarillo oscuro': '#F9A825',
    'mostaza': '#D4A017',
    'amber': '#FFBF00',

    // Reds
    'rojo': '#D0342C',
    'rojo oscuro': '#8B0000',
    'borgona': '#800020',
    'borgoña': '#800020',
    'vino': '#722F37',
    'coral': '#FF6F61',
    'rosa': '#E91E63',
    'rosa palo': '#F4C2C2',
    'rosa antiguo': '#C08081',
    'salmon': '#FA8072',
    'salmón': '#FA8072',
    'fucsia': '#FF00FF',

    // Oranges
    'naranja': '#F57C00',
    'naranjo': '#F57C00',
    'terracota': '#C04000',

    // Blues
    'azul': '#1976D2',
    'azul marino': '#001F3F',
    'azul oscuro': '#1A237E',
    'celeste': '#87CEEB',
    'turquesa': '#1ABC9C',
    'cian': '#00BCD4',
    'aqua': '#00FFFF',

    // Greens
    'verde': '#388E3C',
    'verde oliva': '#556B2F',
    'verde olivo': '#556B2F',
    'verde menta': '#98FF98',
    'verde agua': '#7FFFD4',
    'verde militar': '#4B5320',
    'verde sage': '#9CAF88',
    'sage': '#9CAF88',
    'oliva': '#808000',

    // Purples
    'morado': '#7B1FA2',
    'violeta': '#673AB7',
    'lila': '#C8A2C8',
    'lavanda': '#B57EDC',
    'purpura': '#800080',
    'púrpura': '#800080',

    // Browns
    'marron': '#6D4C41',
    'marrón': '#6D4C41',
    'cafe': '#6F4E37',
    'café': '#6F4E37',
    'chocolate': '#3E2723',
    'beige': '#D7CCA0',
    'arena': '#E5C8A8',
    'tostado': '#A0826D',

    // Neutrals
    'blanco': '#FFFFFF',
    'crema': '#FFFDD0',
    'marfil': '#FFFFF0',
    'negro': '#1A1A1A',
    'gris': '#808080',
    'gris claro': '#BDBDBD',
    'gris oscuro': '#424242',
    'plata': '#C0C0C0',

    // Special
    'dorado': '#D4AF37',
    'oro': '#D4AF37',
    'cobre': '#B87333',
    'bronce': '#CD7F32',
  };

  return map[normalized] || null;
}

/**
 * Apply the swatch fabric (full pattern + texture + color) to the LEFT half
 * of an infografia hero, preserving the hero's text/icons/layout via blend
 * mode compositing.
 *
 * Previous version applied only a solid color tint (dominant color from
 * the swatch). That lost the swatch's actual pattern entirely — e.g. a
 * floral "Amarillo" swatch produced a flat yellow left-half with no flowers.
 * The user wants the real fabric surface (floral watercolor pattern, quilting
 * channels, etc.) to appear in the Banva side of the comparison shot.
 *
 * Strategy: crop the swatch to its fabric region, resize to the left-half
 * dimensions, composite over the hero with `multiply` blend mode. Multiply
 * keeps dark text/icons visible (dark × anything = dark) while transferring
 * the swatch pattern onto the waffle/light areas.
 *
 * Gemini is never called, so text content is guaranteed pixel-perfect —
 * which was the original motivation for the Sharp shortcut (Gemini corrupts
 * text even with explicit "preserve text" instructions).
 *
 * @param heroBuffer The hero/source infografia image
 * @param swatchBuffer The swatch image (full product photo OK, cropped internally)
 * @param _explicitHex DEPRECATED (ignored). Kept for backwards compat until
 *                     all callers stop passing it.
 */
export async function tintInfografiaLeftHalf(
  heroBuffer: Buffer,
  swatchBuffer: Buffer,
  _explicitHex?: string | null,
): Promise<Buffer> {
  const heroMeta = await sharp(heroBuffer).metadata();
  const W = heroMeta.width || 1200;
  const H = heroMeta.height || 1200;
  const halfW = Math.floor(W / 2);

  // Tighter fabric crop than cropSwatchToFabric — the generic crop takes
  // y 30%-70%, which for a bedroom lifestyle swatch still includes pillows
  // and the top of the headboard. Infografia composition needs ONLY flat
  // fabric surface, so we take y 55%-90% (the middle-lower portion of the
  // quilt, well away from headboard/pillows/footer).
  const swatchMeta = await sharp(swatchBuffer).metadata();
  const sw = swatchMeta.width || 800;
  const sh = swatchMeta.height || 800;
  const cropLeft = Math.round(sw * 0.20);
  const cropTop = Math.round(sh * 0.55);
  const cropW = Math.round(sw * 0.60);
  const cropH = Math.round(sh * 0.35);
  const fabricCrop = await sharp(swatchBuffer)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .toBuffer();

  // Brighten the fabric crop before compositing. The raw crop has real-world
  // shading and folds that make the average pixel ~60-70% lightness, so a
  // multiply blend with the hero's gray waffle (~85% lightness) produces
  // muddy colors. We lift midtones so the fabric AVERAGE is near-white while
  // the pattern (darker flowers, shadows) stays visible in contrast. Linear
  // a=1.4, b=20 approximately maps 120 -> 188, 200 -> 300(clamped), 40 -> 76.
  const brightenedFabric = await sharp(fabricCrop)
    .linear(1.35, 15)
    .modulate({ saturation: 1.2 })  // boost saturation slightly after brightening
    .toBuffer();

  // Resize the cropped+brightened fabric to the left-half dimensions.
  const swatchLayer = await sharp(brightenedFabric)
    .resize(halfW, H, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  // Multiply blend: text/icons (dark) × fabric = still dark → preserved.
  // Waffle (light gray) × fabric (brightened) = fabric pattern at near-full
  // saturation because the fabric was pre-lifted to compensate for the hero
  // not being pure white.
  const result = await sharp(heroBuffer)
    .composite([
      {
        input: swatchLayer,
        left: 0,
        top: 0,
        blend: 'multiply',
      },
    ])
    .png()
    .toBuffer();

  console.log(`[image-processing] Applied swatch fabric (tight crop + brighten) to infografia left half (${halfW}x${H})`);
  return result;
}

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
 * Crop a swatch image to its central fabric zone. Used for all categories
 * that set preprocessing.crop_swatch = true. Output is 800x800.
 *
 * Crop zone: y 45%-90% of height, x 15%-85% of width — lower-middle of the
 * swatch photo, where the fabric body is maximally visible without
 * headboard/pillows/footer contamination (for bedroom lifestyle swatches)
 * or centered framing (for most other categories).
 *
 * For categories that ALSO need pattern density doubling (quilts, cubrecamas,
 * plumones — products with small pillowcase surfaces that otherwise end up
 * half-white when the pattern is sparse), use cropAndTileSwatchToFabric
 * instead of this function.
 */
export async function cropSwatchToFabric(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  const cropLeft = Math.round(width * 0.15);
  const cropTop = Math.round(height * 0.45);
  const cropWidth = Math.round(width * 0.70);
  const cropHeight = Math.round(height * 0.45);

  console.log(`[image-processing] Cropping swatch: original ${width}x${height}, crop region x=${cropLeft}-${cropLeft + cropWidth} y=${cropTop}-${cropTop + cropHeight}`);

  const cropped = await sharp(imageBuffer)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, width - cropLeft),
      height: Math.min(cropHeight, height - cropTop),
    })
    .resize(800, 800, { fit: 'cover' })
    .jpeg({ quality: 92 })
    .toBuffer();

  console.log(`[image-processing] Cropped swatch to fabric zone -> 800x800`);
  return cropped;
}

/**
 * Crop a swatch to its fabric zone AND tile the result 2x2 to double motif
 * density. Use for categories where the product set includes small fabric
 * surfaces (pillowcases) that would otherwise show white background from
 * the swatch pattern's negative space ("half-covered pillowcase" bug on
 * job e00c5c59).
 *
 * Should be used for quilts, cubrecamas, plumones — not for toallas,
 * cortinas, or other close-up swatches where the pattern is already dense.
 * Gated by strategy.preprocessing.tile_swatch.
 */
export async function cropAndTileSwatchToFabric(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  const cropLeft = Math.round(width * 0.15);
  const cropTop = Math.round(height * 0.45);
  const cropWidth = Math.round(width * 0.70);
  const cropHeight = Math.round(height * 0.45);

  // Step 1: crop the fabric region and resize to a 400x400 tile
  const tile = await sharp(imageBuffer)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, width - cropLeft),
      height: Math.min(cropHeight, height - cropTop),
    })
    .resize(400, 400, { fit: 'cover' })
    .toBuffer();

  // Step 2: tile the 400x400 fabric 2x2 into an 800x800 canvas. This doubles
  // the motif density relative to the output surface — small fabric areas
  // (pillowcases) end up with 4x more motifs, eliminating white halves.
  const tiled = await sharp({
    create: {
      width: 800,
      height: 800,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: tile, left: 0, top: 0 },
      { input: tile, left: 400, top: 0 },
      { input: tile, left: 0, top: 400 },
      { input: tile, left: 400, top: 400 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  console.log(`[image-processing] Cropped + tiled swatch 2x2 -> 800x800 (denser pattern for pillowcases)`);
  return tiled;
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

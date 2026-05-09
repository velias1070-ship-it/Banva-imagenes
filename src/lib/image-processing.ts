import sharp from 'sharp';

const DARK_SWATCH_THRESHOLD = 115; // brightness 0-255 — swatch images include context (pillows, bg) that raise the average

/**
 * Get the dominant SATURATED color of an image as RGB values.
 *
 * Uses a saturation-aware approach: filters out near-white, near-black,
 * and near-grey pixels, then averages the remaining "colorful" pixels.
 * This answers "what's the most vivid color in the image" — useful when
 * you want the pattern/accent color of a fabric, NOT the base color.
 *
 * WARNING: do NOT use this for Delta-E fabric-color checks on swatches
 * that have a pattern over a light base (e.g. white sheets with printed
 * floral borders). It will return the pattern color and reject outputs
 * that correctly reproduce the base. Use `getProductBaseColor` for that.
 * See src/lib/image-processing.ts:computeSwatchOutputDeltaE for the
 * chosen policy.
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
 * Get the BASE color of a product as RGB values — the color of the largest
 * contiguous cluster in the image, regardless of saturation.
 *
 * Quantizes every pixel to a 5-bit-per-channel bin (32 levels, 32768 bins),
 * finds the bin with the most pixels, and returns the mean of the pixels that
 * landed in it. For a flat red sheet it returns red. For a white sheet with
 * printed purple borders it returns white (the base, which is what the model
 * must reproduce to match the product).
 *
 * This function exists because `getDominantColor` filters by saturation and
 * therefore returns the PATTERN color on swatches that have a white base with
 * colored accents — causing false Delta-E rejects in the Sabanas Cannon line.
 * Validated against real swatches of project 1967331d (Cannon 144h): the base
 * color comes out ~RGB(210,210,215) for all four tested swatches, matching
 * the actual white-with-accents product. See audit 2026-04-15 job 1017bdb7.
 */
export async function getProductBaseColor(imageBuffer: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(imageBuffer)
    .resize(150, 150, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const bins = new Map<string, { count: number; sumR: number; sumG: number; sumB: number }>();

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = `${r >> 3}|${g >> 3}|${b >> 3}`;
    const bin = bins.get(key);
    if (bin) {
      bin.count++;
      bin.sumR += r;
      bin.sumG += g;
      bin.sumB += b;
    } else {
      bins.set(key, { count: 1, sumR: r, sumG: g, sumB: b });
    }
  }

  let top: { count: number; sumR: number; sumG: number; sumB: number } | null = null;
  for (const bin of bins.values()) {
    if (!top || bin.count > top.count) top = bin;
  }

  if (!top) {
    const stats = await sharp(imageBuffer).stats();
    return {
      r: Math.round(stats.channels[0]?.mean ?? 200),
      g: Math.round(stats.channels[1]?.mean ?? 200),
      b: Math.round(stats.channels[2]?.mean ?? 200),
    };
  }

  return {
    r: Math.round(top.sumR / top.count),
    g: Math.round(top.sumG / top.count),
    b: Math.round(top.sumB / top.count),
  };
}

/**
 * Convert RGB [0-255] to CIE LAB color space via XYZ (D65 illuminant).
 * Used for perceptually meaningful color distance (Delta-E).
 */
function rgbToLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  // sRGB to linear RGB (inverse gamma)
  const toLinear = (v: number) => {
    const vn = v / 255;
    return vn > 0.04045 ? Math.pow((vn + 0.055) / 1.055, 2.4) : vn / 12.92;
  };
  const rn = toLinear(r);
  const gn = toLinear(g);
  const bn = toLinear(b);

  // Linear RGB to XYZ (D65)
  const X = (rn * 0.4124 + gn * 0.3576 + bn * 0.1805) * 100;
  const Y = (rn * 0.2126 + gn * 0.7152 + bn * 0.0722) * 100;
  const Z = (rn * 0.0193 + gn * 0.1192 + bn * 0.9505) * 100;

  // Normalize to D65 white point
  const xn = X / 95.047;
  const yn = Y / 100.0;
  const zn = Z / 108.883;

  // XYZ to LAB
  const f = (t: number) => (t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116);
  const fx = f(xn);
  const fy = f(yn);
  const fz = f(zn);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/**
 * Delta-E CIE76 — perceptual color distance between two LAB colors.
 * Interpretation scale:
 *   ΔE < 1     — imperceptible
 *   1 to 2     — just perceptible (expert eye)
 *   2 to 10    — perceptible at a glance
 *   10 to 25   — clear difference
 *   25 to 50   — obvious shift
 *   > 50       — colors more different than similar
 *
 * Textile threshold for BANVA: > 25 blocks the output and triggers retry,
 * since the research (`research/2026-04-14-...:163`) marks Delta-E as
 * "crítico para textiles" and at >25 the color is visibly wrong even to
 * non-expert eyes on a retail listing.
 */
function deltaECIE76(
  lab1: { L: number; a: number; b: number },
  lab2: { L: number; a: number; b: number },
): number {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Compute perceptual color distance (Delta-E LAB) between the swatch and
 * the generated output, using each image's dominant color. This catches
 * color drift BEFORE the expensive VLM verifier call.
 *
 * For the output image, samples only a center region (where the product
 * typically lives) to reduce the influence of hero background pixels that
 * would pollute the mean. The swatch buffer is assumed to already be
 * cropped to fabric (i.e., the output of `cropSwatchToFabric` or similar).
 *
 * Returns a Promise<{ deltaE: number; swatchRgb, outputRgb }> for logging.
 */
export async function computeSwatchOutputDeltaE(
  swatchCroppedBuffer: Buffer,
  outputBuffer: Buffer,
  opts?: { swatchOriginalBuffer?: Buffer; swatchOriginalMime?: string; cachedSwatchHex?: string | null; rejectThreshold?: number },
): Promise<{ deltaE: number; swatchRgb: { r: number; g: number; b: number }; outputRgb: { r: number; g: number; b: number }; swatchSource: 'pixel' | 'vlm' | 'cache'; outputSource: 'pixel' | 'vlm' }> {
  // Center crop the output (60% of width, 50% of height, offset downward
  // to skip sky/ceiling). This isolates the product region from the scene.
  const outMeta = await sharp(outputBuffer).metadata();
  const ow = outMeta.width || 1200;
  const oh = outMeta.height || 1200;
  const insetX = Math.round(ow * 0.2);
  const insetY = Math.round(oh * 0.3);
  const insetW = Math.max(100, Math.round(ow * 0.6));
  const insetH = Math.max(100, Math.round(oh * 0.5));
  const outputCentered = await sharp(outputBuffer)
    .extract({ left: insetX, top: insetY, width: insetW, height: insetH })
    .png()
    .toBuffer();

  // Swatch color: prefer cached VLM hex → pixel algo → VLM fallback if pixel
  // returns near-white (indicates lifestyle shot where crop sampled background
  // walls/window instead of fabric). See jobs e377b96a/77ef02f8/0ec11ee3/13fb9aff
  // from 2026-04-21: Moka curtains swatch samples #F1F2EC (studio wall white)
  // causing false Delta-E rejects of correctly-generated taupe outputs.
  let swatchRgb: { r: number; g: number; b: number };
  let swatchSource: 'pixel' | 'vlm' | 'cache' = 'pixel';

  if (opts?.cachedSwatchHex) {
    const cached = hexToRgb(opts.cachedSwatchHex);
    if (cached) {
      swatchRgb = cached;
      swatchSource = 'cache';
    } else {
      swatchRgb = await getProductBaseColor(swatchCroppedBuffer);
    }
  } else {
    swatchRgb = await getProductBaseColor(swatchCroppedBuffer);
  }

  // Near-white fallback: if pixel algo yields pure-white (all channels > 235),
  // it likely sampled a studio wall, not fabric. Real white textiles register
  // ~210-225 due to texture/folds. Retry with VLM on the ORIGINAL (uncropped)
  // swatch so it can read the full scene and isolate the product.
  if (swatchSource !== 'cache' && swatchRgb.r > 235 && swatchRgb.g > 235 && swatchRgb.b > 235 && opts?.swatchOriginalBuffer) {
    try {
      const mod = await import('@/lib/swatch-color-agent');
      const vlm = await mod.extractSwatchBaseColorVLM(opts.swatchOriginalBuffer, opts.swatchOriginalMime || 'image/jpeg');
      if (vlm) {
        swatchRgb = { r: vlm.r, g: vlm.g, b: vlm.b };
        swatchSource = 'vlm';
      }
    } catch {
      // VLM failed (rate limit, parse error, etc.) — keep pixel result
    }
  }

  let outputRgb = await getProductBaseColor(outputCentered);
  let outputSource: 'pixel' | 'vlm' = 'pixel';

  const lab1 = rgbToLab(swatchRgb.r, swatchRgb.g, swatchRgb.b);
  let lab2 = rgbToLab(outputRgb.r, outputRgb.g, outputRgb.b);
  let deltaE = deltaECIE76(lab1, lab2);

  // VLM verify on BOTH sides when pixel sampling yields rejection-level deltaE.
  // Contamination can happen in both directions:
  //   - Output: text overlays, dimensions arrows, packaging labels, windows,
  //     plants, furniture sampled instead of fabric.
  //   - Swatch: lifestyle shots with wood headboards, patterned bedding,
  //     rugs-on-floors — pixel samples a non-fabric element.
  // The near-white heuristic above only catches white-background contamination;
  // for dark/colored contamination (Lady sabana: pixel=(100,92,83) from wood
  // headboard while real fabric is pink), we fall back to VLM here.
  // Cost: ~$0.002-0.004 only on jobs that pixel says should be rejected.
  const rejectThreshold = opts?.rejectThreshold ?? 25;
  if (deltaE > rejectThreshold) {
    const mod = await import('@/lib/swatch-color-agent');
    // Output VLM (almost always helps — generated scenes are cluttered)
    try {
      const vlmOut = await mod.extractSwatchBaseColorVLM(outputBuffer, 'image/png');
      if (vlmOut) {
        outputRgb = { r: vlmOut.r, g: vlmOut.g, b: vlmOut.b };
        outputSource = 'vlm';
      }
    } catch { /* ignore */ }
    // Swatch VLM if still not from cache/vlm (pixel was used and may be wrong)
    if (swatchSource === 'pixel' && opts?.swatchOriginalBuffer) {
      try {
        const vlmSw = await mod.extractSwatchBaseColorVLM(opts.swatchOriginalBuffer, opts.swatchOriginalMime || 'image/jpeg');
        if (vlmSw) {
          swatchRgb = { r: vlmSw.r, g: vlmSw.g, b: vlmSw.b };
          swatchSource = 'vlm';
        }
      } catch { /* ignore */ }
    }
    // Recompute with whichever improved values we got
    lab2 = rgbToLab(outputRgb.r, outputRgb.g, outputRgb.b);
    const lab1b = rgbToLab(swatchRgb.r, swatchRgb.g, swatchRgb.b);
    deltaE = deltaECIE76(lab1b, lab2);
  }

  return { deltaE, swatchRgb, outputRgb, swatchSource, outputSource };
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
 * Classify an RGB color to a Spanish color-family name. Used to inject the
 * hero color into the prompt so Gemini knows what color to AVOID. Manual
 * A/B confirmed Pro suppresses leaks much better when both source ("azul
 * claro") and destination ("Gris") colors are named in the prompt vs only
 * the destination (jobs 5b673072, de50e6c0 — Gris swatch + light-blue
 * flannel hero).
 */
export function rgbToSpanishColorName(r: number, g: number, b: number): string {
  // Convert to HSL for cleaner classification
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0));
    else if (max === gN) h = ((bN - rN) / d + 2);
    else h = ((rN - gN) / d + 4);
    h *= 60;
  }
  // Neutrals first (low saturation)
  if (s < 0.10) {
    if (l > 0.85) return 'blanco';
    if (l > 0.65) return 'gris claro';
    if (l > 0.40) return 'gris';
    if (l > 0.20) return 'gris oscuro';
    return 'negro';
  }
  // Light pastels (high lightness, low-mid saturation)
  if (l > 0.78 && s < 0.35) {
    if (h >= 180 && h < 260) return 'celeste';
    if (h >= 0 && h < 30) return 'rosa pálido';
    if (h >= 30 && h < 70) return 'crema';
    if (h >= 70 && h < 170) return 'verde claro';
    if (h >= 260 && h < 320) return 'lila pálido';
    return 'pastel claro';
  }
  // Saturated families by hue
  if (h < 15 || h >= 345) return l < 0.4 ? 'rojo oscuro' : (l > 0.7 ? 'rosa' : 'rojo');
  if (h < 45) return l > 0.7 ? 'salmón' : 'naranja';
  if (h < 65) return l > 0.7 ? 'amarillo claro' : 'amarillo';
  if (h < 90) return 'amarillo verdoso';
  if (h < 160) return l < 0.4 ? 'verde oscuro' : (l > 0.65 ? 'verde claro' : 'verde');
  if (h < 200) return l > 0.65 ? 'celeste' : (l < 0.4 ? 'azul oscuro' : 'azul');
  if (h < 250) return l > 0.7 ? 'azul claro' : (l < 0.35 ? 'azul marino' : 'azul');
  if (h < 290) return l > 0.65 ? 'lila' : (l < 0.35 ? 'morado oscuro' : 'morado');
  if (h < 345) return l > 0.65 ? 'rosa' : 'fucsia';
  return 'desconocido';
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
 * Crop a swatch image to the FLAT TOP of the product (no drape).
 *
 * Crop zone: y 50%-78%, x 20%-80% — this captures the flat top surface of
 * the bed where the fabric's TRUE pattern direction is visible. The
 * previous zone y 45%-90% included the front drape of the quilt, where
 * horizontal stripes appear as vertical lines due to perspective (the
 * fabric hangs vertically off the front of the bed). Gemini saw both the
 * flat horizontal stripes AND the vertical drape lines and replicated
 * both directions, producing plaid-like outputs for simple stripe swatches.
 *
 * Tight flat-top crop eliminates the drape perspective artifact.
 * Output: 800x800 square (covers, which vertically stretches the tight
 * band slightly — fine for Gemini, it still reads the pattern correctly).
 */
export async function cropSwatchToFabric(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 800;

  const cropLeft = Math.round(width * 0.20);
  const cropTop = Math.round(height * 0.50);
  const cropWidth = Math.round(width * 0.60);
  const cropHeight = Math.round(height * 0.28);

  console.log(`[image-processing] Cropping swatch (flat-top): original ${width}x${height}, crop region x=${cropLeft}-${cropLeft + cropWidth} y=${cropTop}-${cropTop + cropHeight}`);

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

  console.log(`[image-processing] Cropped swatch to flat-top zone -> 800x800`);
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

  // Same flat-top crop as cropSwatchToFabric (see that function for rationale).
  const cropLeft = Math.round(width * 0.20);
  const cropTop = Math.round(height * 0.50);
  const cropWidth = Math.round(width * 0.60);
  const cropHeight = Math.round(height * 0.28);

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

/**
 * Pixel-perfect overlay restore. After Gemini edit-mode generation, the model
 * re-renders any text/logo overlays from the hero with subtle font/style drift
 * (different weight, missing taglines, slight position shift). For categories
 * where the result MUST match the hero overlay layer exactly (e.g. limpiapies
 * heros with infographic cotas + BANVA branding), copy the original hero
 * pixels for each detected text bbox over the generated result.
 *
 * Inputs are expected at the same dimensions; result is resized to hero's W/H
 * if it isn't already.
 *
 * Bbox padding: 4px on each side to capture anti-aliasing fringes that would
 * otherwise leave a halo of the regenerated text peeking around the original.
 */
export async function compositeHeroOverlays(
  heroBuffer: Buffer,
  resultBuffer: Buffer,
  bboxes: Array<{ text?: string; x: number; y: number; width: number; height: number }>,
): Promise<Buffer> {
  if (!bboxes || bboxes.length === 0) return resultBuffer;

  const heroMeta = await sharp(heroBuffer).metadata();
  const W = heroMeta.width || 1200;
  const H = heroMeta.height || 1200;

  // Normalize result to hero dimensions so bbox coords align.
  const resultMeta = await sharp(resultBuffer).metadata();
  const sameSize = resultMeta.width === W && resultMeta.height === H;
  const baseBuffer = sameSize
    ? resultBuffer
    : await sharp(resultBuffer)
        .resize(W, H, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer();

  // Filter invalid bboxes once.
  const valid = bboxes.filter(
    (b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width > 0 && b.height > 0,
  );
  if (valid.length === 0) return baseBuffer;

  // ── Cluster bboxes by Y-proximity ──
  // Bboxes within 200px vertical gap are part of the same UI element (a
  // logo block, a cartel, a header bar). Compositing the *cluster* as one
  // alpha-masked region eliminates per-word rectangular halos that the
  // earlier per-bbox approach produced.
  const sorted = [...valid].sort((a, b) => a.y - b.y);
  const clusters: typeof sorted[] = [];
  let current: typeof sorted = [];
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

  // Chroma-key tunables. Only pixels with RGB distance > effective threshold
  // from the corner-sampled BG survive as opaque. With NEAR=14, FAR=80, BIN=100,
  // the effective threshold is ~40 — aggressive enough to drop near-fabric
  // panel backdrops *and* near-wall lamp/cabinet pixels that would otherwise
  // get pasted as floating shapes on contrasting bases (e.g. malva on white).
  // Trade-off: panel "container" rectangles are removed; text floats on the
  // generated fabric color directly. Acceptable for the typical use case.
  const GROUP_PAD = 30;
  const NEAR_DIST = 14;
  const FAR_DIST = 80;
  const CORNER_SAMPLE = 12;
  const ALPHA_BINARIZE_THRESHOLD = 100;

  const composites: import('sharp').OverlayOptions[] = [];

  for (const group of clusters) {
    // Union bbox + pad — the corners of this rect should land outside the
    // panel/logo and inside the hero's surrounding fabric, so they sample
    // the "background to remove" cleanly.
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

    // Sample BG from the four corners (each CORNER_SAMPLE × CORNER_SAMPLE).
    const cs = Math.min(CORNER_SAMPLE, Math.floor(Math.min(cw, ch) / 2));
    if (cs <= 0) continue;
    const cornerRects = [
      { left, top, width: cs, height: cs },
      { left: right - cs, top, width: cs, height: cs },
      { left, top: bottom - cs, width: cs, height: cs },
      { left: right - cs, top: bottom - cs, width: cs, height: cs },
    ];
    // sharp quirk: .extract(...).stats() returns stats of the SOURCE image,
    // not the cropped region — must materialize to a buffer first.
    let bgR = 0, bgG = 0, bgB = 0;
    for (const c of cornerRects) {
      const cornerBuf = await sharp(heroBuffer).extract(c).toBuffer();
      const stats = await sharp(cornerBuf).stats();
      bgR += stats.channels[0].mean;
      bgG += stats.channels[1].mean;
      bgB += stats.channels[2].mean;
    }
    bgR /= 4; bgG /= 4; bgB /= 4;

    // Build alpha-masked patch by chroma-keying the sampled BG.
    const { data, info } = await sharp(heroBuffer)
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
  }

  if (composites.length === 0) return baseBuffer;

  const composited = await sharp(baseBuffer).composite(composites).png().toBuffer();
  console.log(`[image-processing] Restored ${composites.length} clustered overlay regions (alpha-masked) onto generated output`);
  return composited;
}

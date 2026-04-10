import sharp from 'sharp';
import { createAdminClient } from '@/lib/supabase/admin';

export interface BrandConfig {
  id: string;
  name: string;
  logo_storage_path: string;
  logo_position: string;
  logo_margin_px: number;
  logo_size_px: number;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  typography: string;
  typography_title: string;
  typography_subtitle: string;
  typography_subsubtitle: string;
  prompt_guidelines: string;
  apply_logo_overlay: boolean;
  apply_to_shot_types: string[];
}

/**
 * Get brand config for a project. Returns null if project has no brand.
 */
export async function getProjectBrand(projectId: string): Promise<BrandConfig | null> {
  const supabase = createAdminClient();

  const { data: project } = await supabase
    .from('projects')
    .select('brand_id')
    .eq('id', projectId)
    .single();

  if (!project?.brand_id) return null;

  const { data: brand } = await supabase
    .from('brands')
    .select('*')
    .eq('id', project.brand_id)
    .single();

  return brand as BrandConfig | null;
}

export interface TextElement {
  text: string;
  role: 'title' | 'subtitle' | 'body' | 'feature' | 'label' | 'icon_label';
  position: 'top' | 'center' | 'bottom';
  size: 'large' | 'medium' | 'small';
}

/**
 * Map text element roles to brand color fields.
 */
const ROLE_COLOR_MAP: Record<TextElement['role'], keyof Pick<BrandConfig, 'primary_color' | 'secondary_color' | 'accent_color'>> = {
  title: 'primary_color',
  subtitle: 'secondary_color',
  body: 'secondary_color',
  feature: 'accent_color',
  label: 'secondary_color',
  icon_label: 'accent_color',
};

/**
 * Map text element roles to per-role typography fields.
 */
const ROLE_TYPOGRAPHY_MAP: Record<TextElement['role'], keyof Pick<BrandConfig, 'typography_title' | 'typography_subtitle' | 'typography_subsubtitle'>> = {
  title: 'typography_title',
  subtitle: 'typography_subtitle',
  body: 'typography_subsubtitle',
  feature: 'typography_subsubtitle',
  label: 'typography_subsubtitle',
  icon_label: 'typography_subsubtitle',
};

/**
 * Build brand-specific prompt additions.
 * Injected into the generation prompt when the project has a brand.
 * When shotType is 'infografia' and logo is at the top, instructs Gemini
 * to shift hero text down to leave room for the logo overlay.
 *
 * When textElements are provided (detected from the hero image), generates
 * SPECIFIC per-element color and typography instructions instead of generic ones.
 */
export function buildBrandPromptSection(brand: BrandConfig, shotType?: string, textElements?: TextElement[] | null, mode: 'full' | 'light' = 'full'): string {
  // If no typography and no guidelines configured, don't inject anything into prompt
  // (logo overlay will still be applied separately by Sharp)
  const hasPerRoleTypography = brand.typography_title?.trim() || brand.typography_subtitle?.trim() || brand.typography_subsubtitle?.trim();
  const hasTypography = hasPerRoleTypography || brand.typography?.trim();
  const hasGuidelines = brand.prompt_guidelines?.trim();
  const hasColors = brand.primary_color || brand.secondary_color || brand.accent_color;
  const hasTextElements = textElements && textElements.length > 0;

  if (!hasTypography && !hasGuidelines && !hasColors) {
    return '';
  }

  const parts: string[] = [];

  parts.push(mode === 'full'
    ? `\n\n=== INSTRUCCIONES DE MARCA (PRIORIDAD MAXIMA) ===`
    : `\n\n=== INSTRUCCIONES DE TEXTO ===`);

  // Logo is overlaid by Sharp in post-process — no need for Gemini to shift text.
  // Previous instruction to "move text out of logo zone" caused Gemini to push
  // content down and crop the bottom of the image.

  parts.push(`OBLIGATORIO: Si la imagen contiene CUALQUIER texto visible, DEBES aplicar estas reglas:`);
  if (mode === 'full') {
    parts.push(`LOGOS Y MARCAS: NO agregues NINGUN logotipo, nombre de marca, watermark, ni insignia que no exista EXACTAMENTE en la Imagen 1 original. Si la Imagen 1 NO tiene logo, el resultado NO debe tener logo. El branding se aplica en post-proceso.`);
  }

  if (hasTextElements && hasColors) {
    // ── SPECIFIC per-element color instructions ──
    // Don't include exact text content — it prevents Gemini from translating English to Spanish.
    // Just specify role → color mapping. Gemini can see the text in the image.
    parts.push(`COLORES DE TEXTO POR ROL:`);
    const seenRoles = new Set<string>();
    for (const el of textElements!) {
      const colorField = ROLE_COLOR_MAP[el.role];
      const colorValue = brand[colorField];
      if (colorValue && !seenRoles.has(el.role)) {
        seenRoles.add(el.role);
        parts.push(`  - ${el.role} → color: ${colorValue}`);
      }
    }
    parts.push(`REEMPLAZAR los colores de texto del hero original por los indicados arriba.`);
  } else if (hasColors) {
    // ── GENERIC color instructions (no text elements detected) ──
    const colors: string[] = [];
    if (brand.primary_color) colors.push(`titulos/texto principal: ${brand.primary_color}`);
    if (brand.secondary_color) colors.push(`texto secundario: ${brand.secondary_color}`);
    if (brand.accent_color) colors.push(`acento/highlights: ${brand.accent_color}`);
    parts.push(`COLORES DE TEXTO OBLIGATORIOS: ${colors.join(' | ')}. REEMPLAZAR los colores de texto del hero original por estos.`);
  }

  if (mode === 'full') {
    if (hasTextElements && hasPerRoleTypography) {
      // ── Per-role typography — don't include text content (allows translation) ──
      const typoRoles = new Set<string>();
      const typoLines: string[] = [];
      for (const el of textElements!) {
        const typoField = ROLE_TYPOGRAPHY_MAP[el.role];
        const typoValue = brand[typoField]?.trim() || brand.typography?.trim();
        if (typoValue && !typoRoles.has(el.role)) {
          typoRoles.add(el.role);
          typoLines.push(`  - ${el.role} → tipografia: ${typoValue}`);
        }
      }
      if (typoLines.length) {
        parts.push(`TIPOGRAFIA POR ROL:`);
        parts.push(...typoLines);
        parts.push(`NO mantener la tipografia original del hero — usar SOLO las tipografias del brand para TODOS los textos.`);
      }
    } else if (hasTextElements && hasTypography) {
      // ── Single font for all text ──
      parts.push(`TIPOGRAFIA OBLIGATORIA: ${brand.typography} para TODOS los textos visibles.`);
      parts.push(`NO mantener la tipografia original del hero — usar SOLO la del brand.`);
    } else if (hasPerRoleTypography) {
      // ── GENERIC per-role typography (no text elements detected) ──
      const typos: string[] = [];
      if (brand.typography_title?.trim()) typos.push(`titulos: ${brand.typography_title}`);
      if (brand.typography_subtitle?.trim()) typos.push(`subtitulos/body/labels: ${brand.typography_subtitle}`);
      if (brand.typography_subsubtitle?.trim()) typos.push(`sub-subtitulos/body/features: ${brand.typography_subsubtitle}`);
      parts.push(`TIPOGRAFIA OBLIGATORIA: ${typos.join(' | ')}. REEMPLAZAR cualquier tipografia del hero original por estas. NO mantener la tipografia original del hero — usar SOLO las del brand.`);
    } else if (hasTypography) {
      // ── GENERIC single typography (backward compatible) ──
      parts.push(`TIPOGRAFIA OBLIGATORIA: ${brand.typography}. REEMPLAZAR cualquier tipografia del hero original por esta. NO mantener la tipografia original del hero — usar SOLO la del brand.`);
    }
  }

  if (hasGuidelines && mode === 'full') {
    parts.push(`REGLAS ADICIONALES: ${brand.prompt_guidelines}`);
  }

  parts.push(mode === 'full' ? `=== FIN INSTRUCCIONES DE MARCA ===` : `=== FIN INSTRUCCIONES DE TEXTO ===`);

  return parts.join('\n');
}

/**
 * Analyze a corner region of the image and return how "busy" it is.
 * Higher stddev = more content (text, edges, objects). Lower = empty/uniform.
 */
async function getCornerBusyness(
  imageBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  corner: string,
  regionW: number,
  regionH: number,
  margin: number
): Promise<number> {
  let left = margin;
  let top = margin;

  switch (corner) {
    case 'top-right':
      left = imgWidth - regionW - margin;
      break;
    case 'bottom-left':
      top = imgHeight - regionH - margin;
      break;
    case 'bottom-right':
      left = imgWidth - regionW - margin;
      top = imgHeight - regionH - margin;
      break;
    case 'top-left':
    default:
      break;
  }

  const extractW = Math.min(regionW, imgWidth - Math.max(0, left));
  const extractH = Math.min(regionH, imgHeight - Math.max(0, top));
  if (extractW <= 0 || extractH <= 0) return 999;

  const region = await sharp(imageBuffer)
    .extract({ left: Math.max(0, left), top: Math.max(0, top), width: extractW, height: extractH })
    .greyscale()
    .raw()
    .toBuffer();

  const pixels = new Uint8Array(region);
  const mean = pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
  const variance = pixels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pixels.length;
  return Math.sqrt(variance);
}

/**
 * Compute the logo's pixel bounding box for a specific corner.
 * Returns { x, y, width, height } in pixel coordinates.
 */
export function getLogoBboxForCorner(
  corner: string,
  brand: BrandConfig,
  imgWidth: number,
  imgHeight: number,
) {
  const margin = brand.logo_margin_px;
  const size = brand.logo_size_px;
  let x = margin;
  let y = margin;
  switch (corner) {
    case 'top-right':
      x = imgWidth - size - margin;
      break;
    case 'bottom-left':
      y = imgHeight - size - margin;
      break;
    case 'bottom-right':
      x = imgWidth - size - margin;
      y = imgHeight - size - margin;
      break;
    case 'top-left':
    default:
      break;
  }
  return { x, y, width: size, height: size };
}

/**
 * Compute the logo's pixel bounding box from brand config and image dimensions.
 * Uses brand.logo_position. Returns { x, y, width, height } in pixel coordinates.
 */
export function getLogoBbox(brand: BrandConfig, imgWidth: number, imgHeight: number) {
  return getLogoBboxForCorner(brand.logo_position, brand, imgWidth, imgHeight);
}

/**
 * Choose the best corner for the logo based on text bbox overlap.
 *
 * For each of the 4 corners, computes the maximum overlap between the logo's
 * bounding box at that corner and any text bbox. Picks the corner with the
 * LOWEST overlap (cleanest), with a strong preference for the brand book corner.
 *
 * Logic:
 *  - If brand book corner has < 5% overlap → use it (don't deviate for tiny noise)
 *  - Else find the lowest-overlap corner
 *  - If brand book corner is within 5% of the best → still use brand book
 *  - Otherwise pick the best alternative
 *
 * Returns the chosen corner, its overlap fraction, and whether it differs from the brand book.
 */
export function chooseBestCornerByBbox(
  imgWidth: number,
  imgHeight: number,
  brand: BrandConfig,
  textBboxes: Array<{ x: number; y: number; width: number; height: number; text?: string }>,
): { corner: string; overlap: number; overridden: boolean; allCorners: Array<{ corner: string; overlap: number }> } {
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  const cornerOverlaps = corners.map((corner) => {
    const logoBox = getLogoBboxForCorner(corner, brand, imgWidth, imgHeight);
    let maxOverlap = 0;
    for (const tb of textBboxes) {
      const overlap = logoOverlapFraction(logoBox, tb);
      if (overlap > maxOverlap) maxOverlap = overlap;
    }
    return { corner, overlap: maxOverlap };
  });

  // Sort by overlap ascending
  const sorted = [...cornerOverlaps].sort((a, b) => a.overlap - b.overlap);
  const best = sorted[0];
  const brandBookEntry = cornerOverlaps.find((c) => c.corner === brand.logo_position)!;

  // Strong preference for brand book corner
  if (brandBookEntry.overlap < 0.05) {
    // Brand book is essentially clear — use it
    return {
      corner: brand.logo_position,
      overlap: brandBookEntry.overlap,
      overridden: false,
      allCorners: cornerOverlaps,
    };
  }

  // Brand book has significant overlap. Use best alternative IF it's notably better.
  // "Notably better" = at least 10 percentage points lower overlap.
  if (brandBookEntry.overlap - best.overlap > 0.1) {
    return {
      corner: best.corner,
      overlap: best.overlap,
      overridden: best.corner !== brand.logo_position,
      allCorners: cornerOverlaps,
    };
  }

  // All corners similarly busy or brand book is close enough — keep brand book
  return {
    corner: brand.logo_position,
    overlap: brandBookEntry.overlap,
    overridden: false,
    allCorners: cornerOverlaps,
  };
}

/**
 * Check if a text bbox overlaps with the logo bbox.
 * Returns the fraction of the logo bbox area that's covered by the text.
 */
export function logoOverlapFraction(
  logoBox: { x: number; y: number; width: number; height: number },
  textBox: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(logoBox.x, textBox.x);
  const y1 = Math.max(logoBox.y, textBox.y);
  const x2 = Math.min(logoBox.x + logoBox.width, textBox.x + textBox.width);
  const y2 = Math.min(logoBox.y + logoBox.height, textBox.y + textBox.height);
  const overlapW = Math.max(0, x2 - x1);
  const overlapH = Math.max(0, y2 - y1);
  const overlapArea = overlapW * overlapH;
  const logoArea = logoBox.width * logoBox.height;
  return logoArea > 0 ? overlapArea / logoArea : 0;
}

/**
 * Check if the brand book's preferred logo zone is clear of content.
 * Measures pixel variance (stddev) of the logo bounding box region.
 * Used to decide whether to override the brand book position when text
 * is detected in the same vertical zone but may have been moved sideways.
 *
 * Returns true if the zone is empty enough for the logo (low variance).
 * Returns false if the zone has visible content (text, product edges, etc).
 */
export async function isLogoZoneClear(imageBuffer: Buffer, brand: BrandConfig): Promise<{ clear: boolean; busyness: number }> {
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 1200;
  const imgHeight = metadata.height || 1200;

  const margin = brand.logo_margin_px;
  const regionW = brand.logo_size_px + margin * 2;
  const regionH = brand.logo_size_px + margin * 2;

  const busyness = await getCornerBusyness(
    imageBuffer,
    imgWidth,
    imgHeight,
    brand.logo_position,
    regionW,
    regionH,
    margin,
  );

  // Threshold tuned empirically:
  //  - empty wood/wall/sky background: stddev ~ 5-20
  //  - text overlay in region: stddev > 30
  //  - product/model with detail: stddev > 40
  const CLEAR_THRESHOLD = 25;
  return { clear: busyness < CLEAR_THRESHOLD, busyness };
}

/**
 * Find the best corner for the logo — the one with least content.
 * Prefers the configured corner if it's reasonably empty.
 */
async function findBestCorner(
  imageBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  logoWidth: number,
  logoHeight: number,
  margin: number,
  preferredCorner: string
): Promise<string> {
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  const scores = await Promise.all(
    corners.map(async (corner) => ({
      corner,
      busyness: await getCornerBusyness(imageBuffer, imgWidth, imgHeight, corner, logoWidth + margin * 2, logoHeight + margin * 2, margin),
    }))
  );

  scores.sort((a, b) => a.busyness - b.busyness);
  const best = scores[0];
  const preferred = scores.find((s) => s.corner === preferredCorner);

  if (preferred && preferred.busyness <= best.busyness * 1.3) {
    console.log(`[brand] Corner "${preferredCorner}" OK (busyness: ${preferred.busyness.toFixed(1)}, best: ${best.corner} ${best.busyness.toFixed(1)})`);
    return preferredCorner;
  }

  console.log(`[brand] Corner "${preferredCorner}" busy (${preferred?.busyness.toFixed(1)}), using "${best.corner}" (${best.busyness.toFixed(1)})`);
  return best.corner;
}

/**
 * Pick the best corner for the logo based on detected text positions.
 * Avoids corners where text elements are located.
 */
function findBestCornerFromText(
  textElements: TextElement[] | null | undefined,
  preferredCorner: string
): string {
  if (!textElements?.length) return preferredCorner;

  // Determine which zones have text
  const hasTopText = textElements.some(el => el.position === 'top');
  const hasBottomText = textElements.some(el => el.position === 'bottom');
  const hasCenterText = textElements.some(el => el.position === 'center');

  const cornerScores: Record<string, number> = {
    'top-left': 0,
    'top-right': 0,
    'bottom-left': 0,
    'bottom-right': 0,
  };

  // Penalize corners in zones with text
  if (hasTopText) {
    cornerScores['top-left'] += 10;
    cornerScores['top-right'] += 10;
  }
  if (hasBottomText) {
    cornerScores['bottom-left'] += 10;
    cornerScores['bottom-right'] += 10;
  }
  if (hasCenterText) {
    // Center text slightly penalizes all corners but less
    cornerScores['top-left'] += 3;
    cornerScores['top-right'] += 3;
    cornerScores['bottom-left'] += 3;
    cornerScores['bottom-right'] += 3;
  }

  // If preferred corner has no penalty, use it
  if (cornerScores[preferredCorner] === 0) {
    console.log(`[brand] Preferred "${preferredCorner}" is clear of text`);
    return preferredCorner;
  }

  // Find the corner with lowest penalty
  const sorted = Object.entries(cornerScores).sort((a, b) => a[1] - b[1]);
  const best = sorted[0];

  // If all corners are equally penalized, use preferred
  if (best[1] === cornerScores[preferredCorner]) {
    console.log(`[brand] All corners have text, using preferred "${preferredCorner}"`);
    return preferredCorner;
  }

  console.log(`[brand] Preferred "${preferredCorner}" has text (score ${cornerScores[preferredCorner]}), using "${best[0]}" (score ${best[1]})`);
  return best[0];
}

/**
 * Overlay brand logo on a generated image.
 * Uses detected text elements to pick a corner without text overlap.
 * Falls back to pixel analysis if no text data, or preferred corner if empty.
 */
export async function overlayBrandLogo(
  imageBuffer: Buffer,
  brand: BrandConfig,
  shotType?: string,
  textElements?: TextElement[] | null,
  forceCorner?: string,
): Promise<Buffer> {
  if (!brand.apply_logo_overlay) {
    console.log('[brand] Logo overlay disabled for brand:', brand.name);
    return imageBuffer;
  }
  if (!brand.logo_storage_path) {
    console.log('[brand] No logo path for brand:', brand.name);
    return imageBuffer;
  }

  if (brand.apply_to_shot_types?.length > 0 && shotType) {
    if (!brand.apply_to_shot_types.includes(shotType)) {
      console.log(`[brand] Shot type "${shotType}" not in filter for brand ${brand.name}`);
      return imageBuffer;
    }
  }

  console.log(`[brand] Applying logo overlay: ${brand.name}, preferred: ${brand.logo_position}`);

  const supabase = createAdminClient();
  const { data: logoData, error } = await supabase.storage
    .from('images')
    .download(brand.logo_storage_path);

  if (error || !logoData) {
    console.error('[brand] Failed to download logo:', error?.message);
    return imageBuffer;
  }

  const logoBuffer = Buffer.from(await logoData.arrayBuffer());

  const resizedLogo = await sharp(logoBuffer)
    .resize(brand.logo_size_px, brand.logo_size_px, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const imageMetadata = await sharp(imageBuffer).metadata();
  const imgWidth = imageMetadata.width || 1200;
  const imgHeight = imageMetadata.height || 1200;

  const logoMetadata = await sharp(resizedLogo).metadata();
  const logoWidth = logoMetadata.width || brand.logo_size_px;
  const logoHeight = logoMetadata.height || brand.logo_size_px;

  const margin = brand.logo_margin_px;

  // If a forceCorner was provided (computed by chooseBestCornerByBbox in the route),
  // use it directly. Otherwise fall back to text-element role-based smart corner.
  const effectiveCorner = forceCorner || findBestCornerFromText(textElements, brand.logo_position);
  const corner_overridden = effectiveCorner !== brand.logo_position;

  let left = margin;
  let top = margin;

  switch (effectiveCorner) {
    case 'top-right':
      left = imgWidth - logoWidth - margin;
      break;
    case 'bottom-left':
      top = imgHeight - logoHeight - margin;
      break;
    case 'bottom-right':
      left = imgWidth - logoWidth - margin;
      top = imgHeight - logoHeight - margin;
      break;
    case 'top-left':
    default:
      break;
  }

  // Logo overlay — transparent, no background plate
  const result = await sharp(imageBuffer)
    .composite([
      { input: resizedLogo, left: Math.max(0, left), top: Math.max(0, top) },
    ])
    .png()
    .toBuffer();

  console.log(`[brand] Logo overlay applied: ${brand.name} at ${effectiveCorner}${corner_overridden ? ` (overridden from ${brand.logo_position} due to text)` : ''} (${logoWidth}x${logoHeight}px)`);
  return result;
}

/**
 * Second-pass Gemini call: move text that overlaps with the logo zone.
 * Only runs when text elements are detected at the logo corner position.
 * Runs AFTER generation, BEFORE logo overlay.
 *
 * Returns modified image buffer, or original if no overlap / on failure.
 */
/**
 * Shift image content down to make room for the logo.
 * Pure Sharp — no AI, deterministic, no text invention.
 *
 * Only runs when text is detected at the top (overlapping logo zone).
 * Shifts the entire image down by the logo height, sampling the top
 * edge to fill the gap. Bottom content is cropped (usually margin).
 */
export async function clearLogoZone(
  imageBuffer: Buffer,
  brand: BrandConfig,
): Promise<Buffer> {
  const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
  if (!logoAtTop) return imageBuffer;

  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width || 1200;
  const imgH = metadata.height || 1200;

  // Shift = full logo height + 2x margin so the logo bbox sits entirely inside
  // the cleared (sampled background) strip at the top.
  // Logo bbox = margin + logo_size_px + margin → min shift is logo_size_px + 2*margin.
  const shiftPx = brand.logo_size_px + brand.logo_margin_px * 2;

  // Sample 5px strip from the top to get a more robust background color
  // (the very first row could contain text antialiasing).
  const sampleH = Math.min(5, imgH);
  const topStrip = await sharp(imageBuffer)
    .extract({ left: 0, top: 0, width: imgW, height: sampleH })
    .resize(1, 1)
    .raw()
    .toBuffer();

  const bgR = topStrip[0] || 255;
  const bgG = topStrip[1] || 255;
  const bgB = topStrip[2] || 255;

  // Create canvas with sampled background color, paste image shifted down.
  // The image content shifts down by shiftPx; the bottom shiftPx is cropped.
  const shifted = await sharp({
    create: {
      width: imgW,
      height: imgH,
      channels: 3,
      background: { r: bgR, g: bgG, b: bgB },
    },
  })
    .composite([
      {
        input: await sharp(imageBuffer)
          .extract({ left: 0, top: 0, width: imgW, height: imgH - shiftPx })
          .toBuffer(),
        left: 0,
        top: shiftPx,
      },
    ])
    .png()
    .toBuffer();

  console.log(`[brand] clearLogoZone: shifted image down ${shiftPx}px (bg: rgb(${bgR},${bgG},${bgB}))`);
  return shifted;
}

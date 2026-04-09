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
  textElements?: TextElement[] | null
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

  // Smart corner: if brand book says "top", pick the less busy top corner.
  // If brand book says "bottom", pick the less busy bottom corner.
  // Respects vertical position (top stays top, bottom stays bottom).
  const isTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
  const isBottom = brand.logo_position === 'bottom-left' || brand.logo_position === 'bottom-right';

  // Analyze both corners on the configured side (top or bottom)
  async function cornerBusyness(x: number, y: number): Promise<number> {
    try {
      const stats = await sharp(imageBuffer)
        .extract({ left: x, top: y, width: logoWidth + 30, height: logoHeight + 20 })
        .stats();
      // Higher stdev = more contrast/text/edges = busier
      const avgStdev = stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length;
      return avgStdev;
    } catch {
      return Infinity;
    }
  }

  let left = margin;
  let top = margin;

  if (isTop) {
    const leftBusy = await cornerBusyness(margin, margin);
    const rightBusy = await cornerBusyness(imgWidth - logoWidth - margin - 30, margin);
    if (rightBusy < leftBusy) {
      left = imgWidth - logoWidth - margin;
      console.log(`[brand] Smart corner: top-right (busy: L=${leftBusy.toFixed(1)}, R=${rightBusy.toFixed(1)})`);
    } else {
      console.log(`[brand] Smart corner: top-left (busy: L=${leftBusy.toFixed(1)}, R=${rightBusy.toFixed(1)})`);
    }
  } else if (isBottom) {
    const leftBusy = await cornerBusyness(margin, imgHeight - logoHeight - margin - 20);
    const rightBusy = await cornerBusyness(imgWidth - logoWidth - margin - 30, imgHeight - logoHeight - margin - 20);
    top = imgHeight - logoHeight - margin;
    if (rightBusy < leftBusy) {
      left = imgWidth - logoWidth - margin;
      console.log(`[brand] Smart corner: bottom-right (busy: L=${leftBusy.toFixed(1)}, R=${rightBusy.toFixed(1)})`);
    } else {
      console.log(`[brand] Smart corner: bottom-left (busy: L=${leftBusy.toFixed(1)}, R=${rightBusy.toFixed(1)})`);
    }
  }

  // Create a soft white background plate behind the logo so it's visible over any content (text, dark areas, etc.)
  // Plate is slightly larger than the logo with rounded edges and 80% opacity.
  const plateWidth = logoWidth + 30;
  const plateHeight = logoHeight + 20;
  const plateLeft = Math.max(0, left - 15);
  const plateTop = Math.max(0, top - 10);
  const plate = await sharp({
    create: {
      width: plateWidth,
      height: plateHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.85 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${plateWidth}" height="${plateHeight}"><rect x="0" y="0" width="${plateWidth}" height="${plateHeight}" rx="12" ry="12" fill="white" fill-opacity="0.85"/></svg>`
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const result = await sharp(imageBuffer)
    .composite([
      { input: plate, left: plateLeft, top: plateTop },
      { input: resizedLogo, left: Math.max(0, left), top: Math.max(0, top) },
    ])
    .png()
    .toBuffer();

  console.log(`[brand] Logo overlay applied with background plate: ${brand.name} at ${brand.logo_position} (${logoWidth}x${logoHeight}px)`);
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
  textElements: TextElement[] | null | undefined
): Promise<Buffer> {
  if (!textElements?.length) return imageBuffer;

  const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
  if (!logoAtTop) return imageBuffer;

  const hasTopText = textElements.some(el => el.position === 'top');
  if (!hasTopText) return imageBuffer;

  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width || 1200;
  const imgH = metadata.height || 1200;

  // Calculate shift: logo height + margin (the area the logo occupies vertically)
  // We only need to shift enough for the logo, not the full logo_size_px (which is max width)
  // Logo is resized to fit inside logo_size_px x logo_size_px, so height <= logo_size_px
  const shiftPx = Math.round(brand.logo_size_px * 0.45); // ~45% of logo size = enough clearance

  // Sample the top-left 1px strip to get the background color
  const topStrip = await sharp(imageBuffer)
    .extract({ left: 0, top: 0, width: imgW, height: 1 })
    .resize(1, 1)
    .raw()
    .toBuffer();

  const bgR = topStrip[0] || 255;
  const bgG = topStrip[1] || 255;
  const bgB = topStrip[2] || 255;

  // Create canvas with sampled background color, paste image shifted down
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

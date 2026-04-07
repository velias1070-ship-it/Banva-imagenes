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
export function buildBrandPromptSection(brand: BrandConfig, shotType?: string, textElements?: TextElement[] | null): string {
  // If no typography and no guidelines configured, don't inject anything into prompt
  // (logo overlay will still be applied separately by Sharp)
  const hasPerRoleTypography = brand.typography_title?.trim() || brand.typography_subtitle?.trim() || brand.typography_subsubtitle?.trim();
  const hasTypography = hasPerRoleTypography || brand.typography?.trim();
  const hasGuidelines = brand.prompt_guidelines?.trim();
  const hasColors = brand.primary_color || brand.secondary_color || brand.accent_color;
  const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
  const isInfoShot = shotType === 'infografia';
  const hasTextElements = textElements && textElements.length > 0;
  // Shift text when logo is at top AND hero has text in the top zone
  const hasTopText = hasTextElements && textElements!.some(el => el.position === 'top');
  const needsTextShift = logoAtTop && (hasTopText || isInfoShot);

  if (!hasTypography && !hasGuidelines && !needsTextShift && !hasColors) {
    return '';
  }

  const parts: string[] = [];

  parts.push(`\n\n=== INSTRUCCIONES DE MARCA (PRIORIDAD MAXIMA) ===`);
  parts.push(`OBLIGATORIO: Si la imagen contiene CUALQUIER texto visible, DEBES aplicar estas reglas:`);
  parts.push(`PROHIBIDO: NO generar logotipos, nombres de marca, ni watermarks en la imagen. NUNCA escribir "${brand.name}" ni ninguna marca en la imagen. El logo se compone automaticamente en post-proceso — si lo generas, quedara DUPLICADO y MAL POSICIONADO.`);

  if (hasTextElements && hasColors) {
    // ── SPECIFIC per-element color instructions ──
    parts.push(`COLORES DE TEXTO POR ELEMENTO (aplicar EXACTAMENTE segun el rol de cada texto):`);
    for (const el of textElements!) {
      const colorField = ROLE_COLOR_MAP[el.role];
      const colorValue = brand[colorField];
      if (colorValue) {
        parts.push(`  - "${el.text}" (${el.role}, ${el.position}, ${el.size}) → color: ${colorValue}`);
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

  if (hasTextElements && hasPerRoleTypography) {
    // ── SPECIFIC per-element typography with per-role fonts ──
    parts.push(`TIPOGRAFIA POR ELEMENTO (aplicar EXACTAMENTE segun el rol de cada texto):`);
    for (const el of textElements!) {
      const typoField = ROLE_TYPOGRAPHY_MAP[el.role];
      const typoValue = brand[typoField]?.trim() || brand.typography?.trim();
      if (typoValue) {
        parts.push(`  - "${el.text}" (${el.role}, ${el.position}, ${el.size}) → tipografia: ${typoValue}`);
      }
    }
    parts.push(`NO mantener la tipografia original del hero — usar SOLO las tipografias del brand para TODOS los textos.`);
  } else if (hasTextElements && hasTypography) {
    // ── SPECIFIC per-element typography with single font (backward compatible) ──
    parts.push(`TIPOGRAFIA OBLIGATORIA (${brand.typography}) — aplicar a cada texto detectado:`);
    for (const el of textElements!) {
      parts.push(`  - "${el.text}" (${el.role}, ${el.position}, ${el.size}) → tipografia: ${brand.typography}`);
    }
    parts.push(`NO mantener la tipografia original del hero — usar SOLO la del brand para TODOS los textos.`);
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

  if (hasGuidelines) {
    parts.push(`REGLAS ADICIONALES: ${brand.prompt_guidelines}`);
  }

  // When hero is infografia (has text) and logo goes at the top, tell Gemini to shift text down
  if (needsTextShift) {
    const clearSpace = brand.logo_size_px + brand.logo_margin_px + 20;
    const side = brand.logo_position === 'top-left' ? 'superior izquierda' : 'superior derecha';
    parts.push(`LOGO EN POST-PROCESO: Se va a agregar un logo de marca en la esquina ${side} de la imagen (aproximadamente ${clearSpace}px desde la esquina). Si el texto del hero original esta en esa zona, DESPLAZA todo el texto hacia abajo para que NO quede en los primeros ${clearSpace}px superiores del lado ${brand.logo_position === 'top-left' ? 'izquierdo' : 'derecho'}. El texto debe quedar DEBAJO del espacio reservado para el logo.`);
  }

  parts.push(`=== FIN INSTRUCCIONES DE MARCA ===`);

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

  // Position logo — always use configured position (brand requirement)
  let left = margin;
  let top = margin;

  switch (brand.logo_position) {
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

  // Build logo with opaque white background to guarantee clean logo area
  // The pill is fully opaque so it covers any text/content behind the logo
  const padX = 16;
  const padY = 12;
  const pillW = logoWidth + padX * 2;
  const pillH = logoHeight + padY * 2;
  const pillRadius = Math.min(14, Math.floor(pillH / 4));

  const pillSvg = Buffer.from(
    `<svg width="${pillW}" height="${pillH}">
      <rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${pillRadius}" ry="${pillRadius}" fill="white" fill-opacity="0.95"/>
    </svg>`
  );

  const logoWithBg = await sharp({
    create: { width: pillW, height: pillH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: pillSvg, left: 0, top: 0 },
      { input: resizedLogo, left: padX, top: padY },
    ])
    .png()
    .toBuffer();

  // Adjust position so the pill is within bounds
  const finalLeft = Math.max(0, Math.min(left - padX, imgWidth - pillW));
  const finalTop = Math.max(0, Math.min(top - padY, imgHeight - pillH));

  const result = await sharp(imageBuffer)
    .composite([
      { input: logoWithBg, left: finalLeft, top: finalTop },
    ])
    .png()
    .toBuffer();

  console.log(`[brand] Logo overlay applied: ${brand.name} at ${brand.logo_position} (${logoWidth}x${logoHeight}px, with bg pill)`);
  return result;
}

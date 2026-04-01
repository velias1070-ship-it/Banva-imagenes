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
  const hasTypography = brand.typography?.trim();
  const hasGuidelines = brand.prompt_guidelines?.trim();
  const hasColors = brand.primary_color || brand.secondary_color || brand.accent_color;
  const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
  const isInfoShot = shotType === 'infografia';
  const needsTextShift = isInfoShot && logoAtTop && brand.apply_logo_overlay && !!brand.logo_storage_path;
  const hasTextElements = textElements && textElements.length > 0;

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

  if (hasTextElements && hasTypography) {
    // ── SPECIFIC per-element typography instructions ──
    parts.push(`TIPOGRAFIA OBLIGATORIA (${brand.typography}) — aplicar a cada texto detectado:`);
    for (const el of textElements!) {
      parts.push(`  - "${el.text}" (${el.role}, ${el.position}, ${el.size}) → tipografia: ${brand.typography}`);
    }
    parts.push(`NO mantener la tipografia original del hero — usar SOLO la del brand para TODOS los textos.`);
  } else if (hasTypography) {
    // ── GENERIC typography instructions ──
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
 * Overlay brand logo on a generated image.
 * Uses the configured corner position. For infografia shots, the prompt
 * already told Gemini to shift text away from the logo zone.
 * Returns the processed buffer, or the original if no logo/brand.
 */
export async function overlayBrandLogo(
  imageBuffer: Buffer,
  brand: BrandConfig,
  shotType?: string
): Promise<Buffer> {
  // Check if overlay should be applied
  if (!brand.apply_logo_overlay) {
    console.log('[brand] Logo overlay disabled for brand:', brand.name);
    return imageBuffer;
  }
  if (!brand.logo_storage_path) {
    console.log('[brand] No logo path for brand:', brand.name);
    return imageBuffer;
  }

  // Check shot type filter
  if (brand.apply_to_shot_types?.length > 0 && shotType) {
    if (!brand.apply_to_shot_types.includes(shotType)) {
      console.log(`[brand] Shot type "${shotType}" not in filter for brand ${brand.name}`);
      return imageBuffer;
    }
  }

  console.log(`[brand] Applying logo overlay: ${brand.name} (${brand.logo_storage_path}) at ${brand.logo_position}`);

  // Download logo
  const supabase = createAdminClient();
  const { data: logoData, error } = await supabase.storage
    .from('images')
    .download(brand.logo_storage_path);

  if (error || !logoData) {
    console.error('[brand] Failed to download logo:', error?.message);
    return imageBuffer;
  }

  const logoBuffer = Buffer.from(await logoData.arrayBuffer());

  // Resize logo to configured size
  const resizedLogo = await sharp(logoBuffer)
    .resize(brand.logo_size_px, brand.logo_size_px, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  // Get image dimensions
  const imageMetadata = await sharp(imageBuffer).metadata();
  const imgWidth = imageMetadata.width || 1200;
  const imgHeight = imageMetadata.height || 1200;

  // Get logo dimensions after resize
  const logoMetadata = await sharp(resizedLogo).metadata();
  const logoWidth = logoMetadata.width || brand.logo_size_px;
  const logoHeight = logoMetadata.height || brand.logo_size_px;

  // Calculate position
  const margin = brand.logo_margin_px;
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

  // Composite logo onto image
  const result = await sharp(imageBuffer)
    .composite([{
      input: resizedLogo,
      left: Math.max(0, left),
      top: Math.max(0, top),
    }])
    .png()
    .toBuffer();

  console.log(`[brand] Logo overlay applied: ${brand.name} at ${brand.logo_position}`);
  return result;
}

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

/**
 * Build brand-specific prompt additions.
 * Injected into the generation prompt when the project has a brand.
 */
export function buildBrandPromptSection(brand: BrandConfig): string {
  // If no typography and no guidelines configured, don't inject anything into prompt
  // (logo overlay will still be applied separately by Sharp)
  const hasTypography = brand.typography?.trim();
  const hasGuidelines = brand.prompt_guidelines?.trim();
  if (!hasTypography && !hasGuidelines) {
    return '';
  }

  const parts: string[] = [];

  parts.push(`\n\n=== INSTRUCCIONES DE MARCA (PRIORIDAD MAXIMA) ===`);
  parts.push(`OBLIGATORIO: Si la imagen contiene CUALQUIER texto visible, DEBES aplicar estas reglas:`);
  parts.push(`PROHIBIDO: NO generar logotipos, nombres de marca, ni watermarks en la imagen. NUNCA escribir "${brand.name}" ni ninguna marca en la imagen. El logo se compone automaticamente en post-proceso — si lo generas, quedara DUPLICADO y MAL POSICIONADO.`);

  if (hasTypography) {
    parts.push(`TIPOGRAFIA OBLIGATORIA: ${brand.typography}. REEMPLAZAR cualquier tipografia del hero original por esta. NO mantener la tipografia original del hero — usar SOLO la del brand.`);
  }

  if (brand.primary_color || brand.accent_color) {
    const colors: string[] = [];
    if (brand.primary_color) colors.push(`titulos/texto principal: ${brand.primary_color}`);
    if (brand.secondary_color) colors.push(`texto secundario: ${brand.secondary_color}`);
    if (brand.accent_color) colors.push(`acento/highlights: ${brand.accent_color}`);
    parts.push(`COLORES DE TEXTO OBLIGATORIOS: ${colors.join(' | ')}. REEMPLAZAR los colores de texto del hero original por estos.`);
  }

  if (hasGuidelines) {
    parts.push(`REGLAS ADICIONALES: ${brand.prompt_guidelines}`);
  }

  parts.push(`=== FIN INSTRUCCIONES DE MARCA ===`);

  return parts.join('\n');
}

/**
 * Analyze a corner region of the image and return how "busy" it is.
 * Higher score = more content (text, objects). Lower = more empty space.
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

  // Extract the corner region
  const region = await sharp(imageBuffer)
    .extract({
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.min(regionW, imgWidth - left),
      height: Math.min(regionH, imgHeight - top),
    })
    .greyscale()
    .raw()
    .toBuffer();

  // Calculate standard deviation of pixel values — high stddev = busy (text, edges, objects)
  const pixels = new Uint8Array(region);
  const mean = pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
  const variance = pixels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pixels.length;
  return Math.sqrt(variance);
}

/**
 * Find the best corner to place the logo — the one with least content.
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
      busyness: await getCornerBusyness(imageBuffer, imgWidth, imgHeight, corner, logoWidth + margin, logoHeight + margin, margin),
    }))
  );

  // Sort by least busy (lowest stddev = most uniform/empty)
  scores.sort((a, b) => a.busyness - b.busyness);

  const preferred = scores.find((s) => s.corner === preferredCorner);
  const best = scores[0];

  // Use preferred corner if it's reasonably empty (within 30% of the best),
  // otherwise use the emptiest corner
  if (preferred && preferred.busyness <= best.busyness * 1.3) {
    console.log(`[brand] Using preferred corner "${preferredCorner}" (busyness: ${preferred.busyness.toFixed(1)}, best: ${best.corner} at ${best.busyness.toFixed(1)})`);
    return preferredCorner;
  }

  console.log(`[brand] Preferred "${preferredCorner}" too busy (${preferred?.busyness.toFixed(1)}), using "${best.corner}" (${best.busyness.toFixed(1)})`);
  return best.corner;
}

/**
 * Overlay brand logo on a generated image.
 * Automatically picks the least busy corner to avoid overlapping text.
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

  console.log(`[brand] Applying logo overlay: ${brand.name} (${brand.logo_storage_path}), preferred: ${brand.logo_position}`);

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

  const margin = brand.logo_margin_px;

  // Smart positioning: find the least busy corner
  const chosenCorner = await findBestCorner(
    imageBuffer, imgWidth, imgHeight,
    logoWidth, logoHeight, margin,
    brand.logo_position
  );

  // Calculate position based on chosen corner
  let left = margin;
  let top = margin;

  switch (chosenCorner) {
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

  console.log(`[brand] Logo overlay applied: ${brand.name} at ${chosenCorner}`);
  return result;
}

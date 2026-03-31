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
  const parts: string[] = [];

  parts.push(`\n\n=== INSTRUCCIONES DE MARCA (PRIORIDAD MAXIMA) ===`);
  parts.push(`Marca: "${brand.name}"`);
  parts.push(`OBLIGATORIO: Si la imagen contiene CUALQUIER texto visible (titulos, descripciones, etiquetas, infografias, numeros, nombres de producto), DEBES aplicar las siguientes reglas de marca:`);

  if (brand.typography) {
    parts.push(`TIPOGRAFIA OBLIGATORIA: ${brand.typography}. REEMPLAZAR cualquier tipografia del hero original por esta. NO mantener la tipografia original del hero — usar SOLO la del brand.`);
  }

  if (brand.primary_color || brand.accent_color) {
    const colors: string[] = [];
    if (brand.primary_color) colors.push(`titulos/texto principal: ${brand.primary_color}`);
    if (brand.secondary_color) colors.push(`texto secundario: ${brand.secondary_color}`);
    if (brand.accent_color) colors.push(`acento/highlights: ${brand.accent_color}`);
    parts.push(`COLORES DE TEXTO OBLIGATORIOS: ${colors.join(' | ')}. REEMPLAZAR los colores de texto del hero original por estos. NO mantener los colores de texto originales.`);
  }

  if (brand.prompt_guidelines) {
    parts.push(`REGLAS ADICIONALES: ${brand.prompt_guidelines}`);
  }

  parts.push(`=== FIN INSTRUCCIONES DE MARCA ===`);

  return parts.join('\n');
}

/**
 * Overlay brand logo on a generated image.
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

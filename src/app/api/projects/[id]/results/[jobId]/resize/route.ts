import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { ensureOutputSpec } from '@/lib/image-processing';
import { getProjectSettings } from '@/lib/project-settings';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

// Size codes used in BANVA SKUs
const SIZE_CODES: Record<string, string> = {
  '15': '1.5 Plazas',
  '20': '2.0 Plazas',
  '25': '2.5 Plazas',
  '30': '3.0 Plazas',
};

/**
 * Derive the 1.5P SKU from the original SKU by replacing the size code.
 * Examples:
 *   TXV23QLAT25BE → TXV23QLAT15BE  (25 → 15)
 *   JSAFAB381P20X → JSAFAB381P15X  (P20 → P15)
 *   TXV24QLBRCN20 → TXV24QLBRCN15 (20 at end → 15)
 */
function deriveSku15P(originalSku: string): string | null {
  if (!originalSku) return null;

  // Pattern 1: "P20", "P25", "P30" → "P15"
  const pMatch = originalSku.match(/P(20|25|30)/);
  if (pMatch) {
    return originalSku.replace(pMatch[0], 'P15');
  }

  // Pattern 2: "20", "25", "30" as standalone size codes in SKU
  // Find the size code — typically 2 digits surrounded by non-digit or at boundaries
  for (const code of ['30', '25', '20']) {
    const idx = originalSku.indexOf(code);
    if (idx >= 0) {
      // Verify it's likely a size code (not part of a longer number context)
      const before = idx > 0 ? originalSku[idx - 1] : '';
      const after = idx + 2 < originalSku.length ? originalSku[idx + 2] : '';
      // Size code is usually preceded by letters and followed by letters or end
      if ((/[A-Za-z]/.test(before) || idx === 0) && (/[A-Za-z]/.test(after) || after === '')) {
        return originalSku.substring(0, idx) + '15' + originalSku.substring(idx + 2);
      }
    }
  }

  return null;
}

/**
 * POST — Generate a 1.5 plaza variant from an approved image.
 * Automatically derives the target SKU for ML publishing.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, jobId } = await context.params;
  const supabase = createAdminClient();

  // Get original job with relations
  const { data: originalJob, error: jobError } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('id', jobId)
    .single();

  if (jobError || !originalJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (!originalJob.output_storage_path) {
    return NextResponse.json({ error: 'Original job has no output image' }, { status: 400 });
  }

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('category, metadata')
    .eq('id', id)
    .single();

  // Derive target SKU for 1.5P
  const swatch = originalJob.swatch as Record<string, string>;
  const originalSku = swatch.sku_suffix || '';
  const targetSku = deriveSku15P(originalSku);

  console.log(`[resize] SKU mapping: ${originalSku} → ${targetSku || '(could not derive)'}`);

  // Create a new job for the 1.5P variant
  const { data: newJob, error: insertError } = await supabase
    .from('generation_jobs')
    .insert({
      batch_id: originalJob.batch_id,
      hero_shot_id: originalJob.hero_shot_id,
      swatch_id: originalJob.swatch_id,
      status: 'generating',
      attempt: 0,
      prompt_metadata: {
        strategy: 'resize_bed',
        source_job_id: jobId,
        target_size: '1.5_plaza',
        original_sku: originalSku,
        target_sku: targetSku,
      },
    })
    .select()
    .single();

  if (insertError || !newJob) {
    return NextResponse.json({ error: insertError?.message || 'Failed to create job' }, { status: 500 });
  }

  // Process in background
  after(async () => {
    try {
      await generateResizedVariant(
        newJob.id,
        originalJob,
        id,
        project?.metadata as Record<string, unknown> | null,
        targetSku
      );
    } catch (err) {
      console.error('[resize] Error:', err);
    }
  });

  return NextResponse.json({
    status: 'generating',
    new_job_id: newJob.id,
    original_sku: originalSku,
    target_sku: targetSku,
  });
}

async function generateResizedVariant(
  newJobId: string,
  originalJob: Record<string, unknown>,
  projectId: string,
  projectMetadata: Record<string, unknown> | null | undefined,
  targetSku: string | null
) {
  const supabase = createAdminClient();
  const swatch = originalJob.swatch as Record<string, string>;
  const heroShot = originalJob.hero_shot as Record<string, string>;
  const projectSettings = getProjectSettings(projectMetadata);

  try {
    // Download the approved output image (2 plazas) as reference
    const outputPath = originalJob.output_storage_path as string;
    const { data: outputData, error: dlError } = await supabase.storage
      .from('images')
      .download(outputPath);

    if (dlError || !outputData) {
      throw new Error('Failed to download source image');
    }

    const sourceBuffer = Buffer.from(await outputData.arrayBuffer());
    const sourceBase64 = sourceBuffer.toString('base64');

    // Download swatch for color reference
    const { data: swatchData, error: swatchDlError } = await supabase.storage
      .from('images')
      .download(swatch.storage_path);

    if (swatchDlError || !swatchData) {
      throw new Error('Failed to download swatch');
    }

    const swatchBuffer = Buffer.from(await swatchData.arrayBuffer());
    const swatchBase64 = swatchBuffer.toString('base64');

    // Build prompt for 1.5 plaza adaptation
    const prompt = `Imagen 1 muestra un producto textil en una cama de 2 plazas con 2 almohadas. Imagen 2 muestra el color/patron exacto del producto.

TAREA: Recrea esta MISMA escena pero adaptada a una cama de 1.5 plaza (cama individual/twin):

CAMBIOS OBLIGATORIOS:
- Cama mas angosta (proporciones de cama de 1 plaza y media / twin)
- Solo 1 almohada (centrada en la cama)
- El producto textil se ve mas pequeno, acorde al tamano de la cama

PRESERVAR EXACTAMENTE:
- El MISMO color, patron y textura del producto — debe coincidir con la Imagen 2 (swatch)
- El MISMO estilo de fotografia, iluminacion y ambiente
- La MISMA composicion general y angulo de camara
- Los MISMOS props y elementos decorativos del entorno
- La MISMA calidad fotografica

NO inventar colores, patrones o texturas que no esten en la Imagen 2.
Todo texto visible DEBE estar en espanol.

Genera una imagen fotorrealista de ${projectSettings.generation.resolution} pixeles, formato cuadrado 1:1, color RGB.`;

    // Generate: approved image as hero (reference), swatch as Image 2 (color)
    const result = await generateImage({
      heroImageBase64: sourceBase64,
      heroMimeType: 'image/png',
      swatchImageBase64: swatchBase64,
      swatchMimeType: swatch.mime_type || 'image/png',
      promptText: prompt,
      temperature: 0.3,
    });

    if (!result.success || !result.imageBase64) {
      throw new Error(result.error || 'Generation failed');
    }

    // Post-process to 1200x1200 sRGB
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    const processedBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // Upload
    const newOutputPath = `projects/${projectId}/generated/${newJobId}.png`;
    await supabase.storage
      .from('images')
      .upload(newOutputPath, processedBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    // Update job with target SKU info
    await supabase
      .from('generation_jobs')
      .update({
        status: 'qa_pending',
        output_storage_path: newOutputPath,
        generation_time_ms: result.durationMs,
        prompt_text: prompt,
        prompt_metadata: {
          strategy: 'resize_bed',
          source_job_id: originalJob.id,
          target_size: '1.5_plaza',
          original_sku: swatch.sku_suffix || null,
          target_sku: targetSku,
          shot_type: heroShot.shot_type,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', newJobId);

    // Trigger QA
    const baseUrl = process.env.APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      || 'http://localhost:3000';

    const batchId = originalJob.batch_id as string;
    if (batchId) {
      fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
        method: 'POST',
      }).catch(() => {});
    }

    console.log(`[resize] Generated 1.5P variant: ${newJobId} (target_sku: ${targetSku})`);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: `1.5P resize: ${errorMessage}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', newJobId);
  }
}

import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { ensureOutputSpec } from '@/lib/image-processing';
import { getProjectSettings } from '@/lib/project-settings';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

/**
 * POST — Generate a 1.5 plaza variant from an approved 2-plaza image.
 * Uses the approved image as reference + swatch, and instructs Gemini
 * to recreate the scene with a narrower bed and 1 pillow.
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
        project?.metadata as Record<string, unknown> | null
      );
    } catch (err) {
      console.error('[resize] Error:', err);
    }
  });

  return NextResponse.json({ status: 'generating', new_job_id: newJob.id });
}

async function generateResizedVariant(
  newJobId: string,
  originalJob: Record<string, unknown>,
  projectId: string,
  projectMetadata?: Record<string, unknown> | null
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

    // Update job
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

    console.log(`[resize] Generated 1.5P variant for job ${newJobId}`);

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

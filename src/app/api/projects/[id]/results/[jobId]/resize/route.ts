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

export async function generateResizedVariant(
  newJobId: string,
  originalJob: Record<string, unknown>,
  projectId: string,
  projectMetadata: Record<string, unknown> | null | undefined,
  targetSku: string | null
) {
  const supabase = createAdminClient();
  const swatch = originalJob.swatch as Record<string, string>;
  const heroShot = originalJob.hero_shot as Record<string, string> | null;
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

    // Try to download swatch for color reference. If the swatch has no physical file
    // (common for ML-imported variants), fall back to single-image mode: the source
    // image already shows the correct color, so we skip the swatch entirely.
    let swatchBase64: string | null = null;
    let swatchMimeType = 'image/png';
    if (swatch?.storage_path) {
      const { data: swatchData, error: swatchDlError } = await supabase.storage
        .from('images')
        .download(swatch.storage_path);
      if (!swatchDlError && swatchData) {
        const swatchBuffer = Buffer.from(await swatchData.arrayBuffer());
        swatchBase64 = swatchBuffer.toString('base64');
        swatchMimeType = swatch.mime_type || 'image/png';
      } else {
        console.log(`[resize] Swatch download failed (${swatchDlError?.message}), using source-only fallback`);
      }
    } else {
      console.log('[resize] Swatch has no storage_path, using source-only fallback');
    }

    const hasSwatch = swatchBase64 !== null;
    const colorAnchor = hasSwatch
      ? 'Imagen 2 muestra el color/patron exacto.'
      : 'El color y patron exactos ya estan en Imagen 1 — preservarlos sin desviacion.';
    const fidelityLine = hasSwatch
      ? '- Mismo color, patron y textura — fiel a Imagen 2'
      : '- Mismo color, patron y textura — identicos a los de Imagen 1';

    // Build prompt for 1.5 plaza adaptation
    const prompt = `Imagen 1 muestra un producto textil (set de 2 plazas). ${colorAnchor}

TAREA: Recrea la Imagen 1 adaptada a un set de 1.5 plaza.

REGLA PRINCIPAL: El set de 1.5 plaza incluye 1 quilt + 1 funda de almohada (NO 2 fundas).
Esto significa que TANTO en el texto como en la imagen visible deben aparecer SOLO 1 funda de almohada.
Si la imagen original muestra 2 fundas (como paquetes doblados, almohadas en cama, o cualquier forma), la nueva imagen debe mostrar SOLO 1.

CAMBIOS OBLIGATORIOS:
1. TEXTO: Donde diga "2 Fundas" o "2 fundas" → cambiar a "1 Funda de Almohada"
2. VISUAL: Donde se vean 2 fundas de almohada → mostrar solo 1
3. VISUAL: Si es cama, poner solo 1 almohada centrada y cama mas angosta
4. Cualquier referencia a "2 plazas" → "1.5 plazas"

QUE NO CAMBIAR:
- Mismo tipo de escena (si es packaging queda packaging, si es cama queda cama)
${fidelityLine}
- Mismo estilo de foto, iluminacion, fondo, props y decoracion
- Mismos iconos, sellos (OEKO-TEX) y elementos graficos
- Misma calidad fotografica

Todo texto en espanol. No inventar colores ni patrones.
Imagen fotorrealista de ${projectSettings.generation.resolution}px, cuadrada 1:1, RGB.`;

    // Generate:
    // - With swatch: source as hero (Image 1) + swatch (Image 2) for color anchor
    // - Without swatch: source as the only image (Image 1), color comes from the source itself
    const result = await generateImage({
      heroImageBase64: hasSwatch ? sourceBase64 : undefined,
      heroMimeType: hasSwatch ? 'image/png' : undefined,
      swatchImageBase64: hasSwatch ? swatchBase64! : sourceBase64,
      swatchMimeType: hasSwatch ? swatchMimeType : 'image/png',
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
          shot_type: heroShot?.shot_type ?? null,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', newJobId);

    // Re-activate batch so health check and QA chain can find it
    const batchId = originalJob.batch_id as string;
    if (batchId) {
      await supabase
        .from('generation_batches')
        .update({ status: 'generating', updated_at: new Date().toISOString() })
        .eq('id', batchId);
    }

    // Trigger QA
    const baseUrl = process.env.APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      || 'http://localhost:3000';

    if (batchId) {
      try {
        await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
          method: 'POST',
        });
        console.log(`[resize] Triggered QA for batch ${batchId}`);
      } catch (err) {
        console.error('[resize] Failed to trigger QA:', err);
      }
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

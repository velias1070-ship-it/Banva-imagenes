import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { ensureOutputSpec } from '@/lib/image-processing';
import { detectShotType } from '@/lib/shot-type-detector';
import { getProjectSettings } from '@/lib/project-settings';
import { buildSizePromptNote } from '@/lib/size-utils';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

/**
 * Reliable self-invocation with retry (same pattern as process-next).
 */
async function reliableFetch(url: string, body: Record<string, unknown>, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status < 500) return true;
      console.error(`[use-as-hero] ${label} returned ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      console.error(`[use-as-hero] ${label} fetch failed (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
    }
  }
  return false;
}

/**
 * POST — Use an approved image as hero base and regenerate for other swatches.
 * Body: { swatch_ids: string[] } — which swatches to generate for.
 * If empty, generates for ALL swatches that don't have an approved image
 * for this hero shot.
 *
 * CHAIN PATTERN: Processes ONE swatch per invocation, then self-invokes
 * with remaining swatch IDs to avoid exceeding serverless timeout.
 *
 * Internal chain body: { _chain: true, _remaining_job_ids: string[],
 *   _source_job_id: string, _project_id: string, _category: string,
 *   _project_metadata: Record<string, unknown> | null }
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId, jobId } = await context.params;
  const supabase = createAdminClient();
  const body = await request.json().catch(() => ({}));

  // ── CHAIN CONTINUATION: process one swatch and chain ──
  if (body._chain) {
    const remainingJobIds: string[] = body._remaining_job_ids || [];
    const sourceJobId: string = body._source_job_id;
    const category: string = body._category || 'textile';
    const projectMetadata: Record<string, unknown> | null = body._project_metadata || null;

    if (!remainingJobIds.length) {
      return NextResponse.json({ status: 'done', message: 'No remaining jobs' });
    }

    const currentJobId = remainingJobIds[0];
    const nextJobIds = remainingJobIds.slice(1);

    // Process ONE swatch
    after(async () => {
      try {
        await generateOneFromApprovedHero(
          sourceJobId,
          currentJobId,
          projectId,
          category,
          projectMetadata,
        );
      } catch (err) {
        console.error(`[use-as-hero] Chain error for job ${currentJobId}:`, err);
      }

      // Self-invoke for next swatch if any remain
      if (nextJobIds.length > 0) {
        const baseUrl = getBaseUrl();
        const selfUrl = `${baseUrl}/api/projects/${projectId}/results/${jobId}/use-as-hero`;
        const dispatched = await reliableFetch(selfUrl, {
          _chain: true,
          _remaining_job_ids: nextJobIds,
          _source_job_id: sourceJobId,
          _category: category,
          _project_metadata: projectMetadata,
        }, 'chain-next');

        if (!dispatched) {
          console.error(`[use-as-hero] CRITICAL: Failed to chain to next swatch. ${nextJobIds.length} jobs remaining.`);
        }
      } else {
        // All done — trigger QA for the batch
        const { data: sourceJob } = await supabase
          .from('generation_jobs')
          .select('batch_id')
          .eq('id', sourceJobId)
          .single();

        if (sourceJob?.batch_id) {
          const baseUrl = getBaseUrl();
          fetch(`${baseUrl}/api/batches/${sourceJob.batch_id}/process-qa`, { method: 'POST' }).catch(() => {});
          console.log(`[use-as-hero] All swatches done, triggered QA for batch ${sourceJob.batch_id}`);
        }
      }
    });

    return NextResponse.json({ status: 'processing', remaining: nextJobIds.length });
  }

  // ── INITIAL INVOCATION: Create jobs and start chain ──
  const targetSwatchIds: string[] | undefined = body.swatch_ids;

  // Get the source job (the approved image to use as hero)
  const { data: sourceJob } = await supabase
    .from('generation_jobs')
    .select('*, hero_shot:hero_shots(*), swatch:swatches(*)')
    .eq('id', jobId)
    .single();

  if (!sourceJob || !sourceJob.output_storage_path) {
    return NextResponse.json({ error: 'Source job not found or has no image' }, { status: 404 });
  }

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('category, metadata')
    .eq('id', projectId)
    .single();

  // Get all swatches for the project
  const { data: allSwatches } = await supabase
    .from('swatches')
    .select('id, name, storage_path, color_description, dominant_color_hex, sku_suffix, mime_type')
    .eq('project_id', projectId)
    .order('display_order');

  if (!allSwatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 400 });
  }

  // Filter: skip the source swatch, and optionally filter by provided IDs
  const sourceSwatchId = (sourceJob.swatch as Record<string, string>).id;
  let targetSwatches = allSwatches.filter((s) => s.id !== sourceSwatchId);

  if (targetSwatchIds?.length) {
    targetSwatches = targetSwatches.filter((s) => targetSwatchIds.includes(s.id));
  }

  if (!targetSwatches.length) {
    return NextResponse.json({ error: 'No target swatches to generate' }, { status: 400 });
  }

  // Create jobs for each target swatch
  const newJobs: { id: string; swatch_name: string }[] = [];

  for (const swatch of targetSwatches) {
    const { data: newJob } = await supabase
      .from('generation_jobs')
      .insert({
        batch_id: sourceJob.batch_id,
        hero_shot_id: sourceJob.hero_shot_id,
        swatch_id: swatch.id,
        status: 'generating',
        attempt: 0,
        prompt_metadata: {
          strategy: 'use_as_hero',
          source_job_id: jobId,
          source_swatch: (sourceJob.swatch as Record<string, string>).name,
        },
      })
      .select()
      .single();

    if (newJob) {
      newJobs.push({ id: newJob.id, swatch_name: swatch.name });
    }
  }

  // Re-activate batch
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', sourceJob.batch_id);

  // Start chain: process first swatch in after(), then self-invoke for rest
  const allJobIds = newJobs.map((j) => j.id);
  const firstJobId = allJobIds[0];
  const remainingJobIds = allJobIds.slice(1);
  const category = project?.category || 'textile';
  const projectMetadata = project?.metadata as Record<string, unknown> | null;

  after(async () => {
    try {
      await generateOneFromApprovedHero(
        jobId,
        firstJobId,
        projectId,
        category,
        projectMetadata,
      );
    } catch (err) {
      console.error(`[use-as-hero] Error processing first swatch:`, err);
    }

    // Chain to next swatch if any remain
    if (remainingJobIds.length > 0) {
      const baseUrl = getBaseUrl();
      const selfUrl = `${baseUrl}/api/projects/${projectId}/results/${jobId}/use-as-hero`;
      const dispatched = await reliableFetch(selfUrl, {
        _chain: true,
        _remaining_job_ids: remainingJobIds,
        _source_job_id: jobId,
        _category: category,
        _project_metadata: projectMetadata,
      }, 'chain-first');

      if (!dispatched) {
        console.error(`[use-as-hero] CRITICAL: Failed to start chain. ${remainingJobIds.length} jobs remaining.`);
      }
    } else {
      // Only one swatch — trigger QA directly
      if (sourceJob.batch_id) {
        const baseUrl = getBaseUrl();
        fetch(`${baseUrl}/api/batches/${sourceJob.batch_id}/process-qa`, { method: 'POST' }).catch(() => {});
      }
    }
  });

  return NextResponse.json({
    status: 'generating',
    jobs_created: newJobs.length,
    jobs: newJobs,
  });
}

/**
 * Process ONE swatch from the approved hero image.
 */
async function generateOneFromApprovedHero(
  sourceJobId: string,
  targetJobId: string,
  projectId: string,
  category: string,
  projectMetadata: Record<string, unknown> | null,
) {
  const supabase = createAdminClient();
  const projectSettings = getProjectSettings(projectMetadata);

  // Get source job for the approved image path
  const { data: sourceJob } = await supabase
    .from('generation_jobs')
    .select('output_storage_path, id, batch_id')
    .eq('id', sourceJobId)
    .single();

  if (!sourceJob?.output_storage_path) {
    throw new Error('Source job not found or has no output');
  }

  // Get target job with swatch info
  const { data: targetJob } = await supabase
    .from('generation_jobs')
    .select('*, swatch:swatches(*)')
    .eq('id', targetJobId)
    .single();

  if (!targetJob) {
    throw new Error(`Target job ${targetJobId} not found`);
  }

  const swatch = targetJob.swatch;

  // Download the approved image (this is the new "hero")
  const { data: heroData } = await supabase.storage.from('images').download(sourceJob.output_storage_path);
  if (!heroData) throw new Error('Failed to download source image');

  const heroBuffer = Buffer.from(await heroData.arrayBuffer());
  const heroBase64 = heroBuffer.toString('base64');

  // Detect shot type of the approved image
  let shotType = 'lifestyle';
  try {
    const detection = await detectShotType(heroBase64, 'image/png');
    if (detection && detection.confidence >= 0.7) {
      shotType = detection.detected_type;
    }
  } catch { /* use default */ }

  const isInfoOrDetail = shotType === 'detail' || shotType === 'infografia';

  try {
    // Download swatch
    const { data: swatchData } = await supabase.storage.from('images').download(swatch.storage_path);
    if (!swatchData) throw new Error(`Failed to download swatch ${swatch.name}`);

    const swatchBuffer = Buffer.from(await swatchData.arrayBuffer());
    const swatchBase64 = swatchBuffer.toString('base64');

    const colorDesc = swatch.color_description || swatch.name;

    // Build prompt — always edit mode (we want to preserve the approved composition exactly)
    const prompt = `Necesito la imagen 1 pero con el diseño textil de la imagen 2.

Esta es una operacion de CAMBIO DE DISEÑO/COLOR UNICAMENTE.
La imagen de salida debe ser IDENTICA a la Imagen 1 en TODO excepto el diseño/color/patron del textil.

Cambia SOLO el diseño y color del producto textil visible al diseño que muestra la Imagen 2 ("${swatch.name}", ${colorDesc}).

DEBE SER IDENTICO a la Imagen 1:
* Mismo angulo de camara, misma perspectiva exacta
* Mismo fondo, misma iluminacion, mismas sombras
* Misma posicion y disposicion del producto en la imagen
* Mismos pliegues, caida y drape de la tela
* Mismo texto superpuesto, iconos y elementos graficos (si los hay)
* Mismos props, muebles y decoracion del entorno

CAMBIAR SOLO: el diseño, patron y color de la tela del producto.
${isInfoOrDetail ? '\nNOTA: La imagen tiene texto/iconos superpuestos — mantenerlos EXACTAMENTE iguales.' : ''}

De la Imagen 2 extraer UNICAMENTE el diseño/patron/color de la tela. NO copiar la composicion, fondo ni layout de la Imagen 2.

IDIOMA: Todo texto visible DEBE estar en español.

Genera una imagen fotorrealista de ${projectSettings.generation.resolution}.${buildSizePromptNote(swatch.sku_suffix, category)}`;

    const result = await generateImage({
      heroImageBase64: heroBase64,
      heroMimeType: 'image/png',
      swatchImageBase64: swatchBase64,
      swatchMimeType: swatch.mime_type || 'image/png',
      promptText: prompt,
      temperature: 0.2,
    });

    if (!result.success || !result.imageBase64) {
      throw new Error(result.error || 'Generation failed');
    }

    // Post-process
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    const processedBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // Upload
    const newOutputPath = `projects/${projectId}/generated/${targetJobId}.png`;
    await supabase.storage.from('images').upload(newOutputPath, processedBuffer, {
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
          strategy: 'use_as_hero',
          source_job_id: sourceJobId,
          detected_shot_type: shotType,
          swatch_color: colorDesc,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetJobId);

    console.log(`[use-as-hero] Generated ${swatch.name} (${targetJobId})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: `use-as-hero: ${msg}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetJobId);
    console.error(`[use-as-hero] Error for ${swatch.name}:`, msg);
  }
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

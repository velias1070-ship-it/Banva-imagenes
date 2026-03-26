import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark, cropSwatchToFabric, flattenHeroEmboss, ensureOutputSpec, createSwatchCollage } from '@/lib/image-processing';
import {
  getCategoryStrategy,
  getEffectiveMode,
  getEffectiveTemperature,
  buildPromptForMode,
} from '@/lib/category-strategy';
import { analyzeSwatchColor } from '@/lib/swatch-analyzer';
import { getProjectSettings } from '@/lib/project-settings';
import { MAX_QA_RETRIES } from '@/lib/constants';

// Vercel serverless: max execution time — one job per invocation (~25s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * CADENA 1 — GENERATION CHAIN
 * Process ONE pending job from a batch, then self-invoke for the next.
 * Does NOT do QA — generates, uploads, sets status=qa_pending, chains.
 * After EACH job → triggers QA chain so both run in parallel.
 *
 * ARCHITECTURE: Heavy work (Gemini API) runs BEFORE the response.
 * Only lightweight chain continuation (fetch calls) runs in after().
 * This prevents Vercel from killing the after() callback mid-generation.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  let shouldChain = false;
  let shouldTriggerQA = false;

  try {
    const result = await processOneJob(batchId);
    shouldChain = result.chain;
    shouldTriggerQA = result.triggerQA;
  } catch (err) {
    console.error('[process-next] Error:', err);
    shouldChain = true; // still try to chain to the next job
  }

  // ── DUAL-DISPATCH: Fire chain triggers BEFORE response (primary) ──
  // fetch() without await dispatches the HTTP request immediately via the
  // underlying TCP layer. Even if this function instance is killed right after
  // returning the response, the receiving Vercel function will already be
  // invoked. The chain handlers are idempotent (they pick the next pending
  // job), so duplicate invocations from after() are harmless.
  const baseUrl = getBaseUrl();
  if (shouldTriggerQA) {
    fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }
  if (shouldChain) {
    fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }

  // ── BACKUP: Also fire in after() in case the above didn't dispatch ──
  if (shouldChain || shouldTriggerQA) {
    after(async () => {
      if (shouldTriggerQA) {
        fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
      if (shouldChain) {
        fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 1500));
    });
  }

  return NextResponse.json({ status: 'processing' });
}

async function processOneJob(batchId: string): Promise<{ chain: boolean; triggerQA: boolean }> {
  const supabase = createAdminClient();

  // Get batch info
  const { data: batch } = await supabase
    .from('generation_batches')
    .select('*, project:projects(*)')
    .eq('id', batchId)
    .single();

  if (!batch) {
    console.log('[process-next] Batch not found:', batchId);
    return { chain: false, triggerQA: false };
  }

  // Check if batch is halted
  if (batch.status === 'halted') {
    console.log('[process-next] Batch is halted, stopping chain:', batchId);
    return { chain: false, triggerQA: false };
  }

  // ── SELF-HEALING: Reset stale "generating" jobs (stuck > 90s) ──
  const staleThreshold = new Date(Date.now() - 90_000).toISOString();
  const { data: staleJobs } = await supabase
    .from('generation_jobs')
    .select('id')
    .eq('batch_id', batchId)
    .eq('status', 'generating')
    .lt('updated_at', staleThreshold);

  if (staleJobs?.length) {
    for (const stale of staleJobs) {
      await supabase
        .from('generation_jobs')
        .update({
          status: 'pending',
          error_message: 'Auto-recovered: stale generating job reset by process-next',
          updated_at: new Date().toISOString(),
        })
        .eq('id', stale.id);
    }
    console.log(`[process-next] Self-healed: reset ${staleJobs.length} stale generating jobs`);
  }

  // ── SELF-HEALING: Trigger QA for stale qa_pending jobs (stuck > 90s) ──
  const { count: staleQaCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .lt('updated_at', staleThreshold);

  if (staleQaCount && staleQaCount > 0) {
    const baseUrlForQA = getBaseUrl();
    fetch(`${baseUrlForQA}/api/batches/${batchId}/process-qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    console.log(`[process-next] Self-healed: triggered QA chain for ${staleQaCount} stale qa_pending jobs`);
  }

  // Get ONE pending job with relations
  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('batch_id', batchId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (!jobs?.length) {
    // No more pending jobs — generation chain complete
    console.log('[process-next] No pending jobs for batch:', batchId);

    // Safety net: ensure QA chain is running for any remaining qa_pending or qa_processing
    const { count: qaNeededCount } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['qa_pending', 'qa_processing']);

    if (qaNeededCount && qaNeededCount > 0) {
      console.log(`[process-next] Safety net: ${qaNeededCount} qa_pending/qa_processing — ensuring QA chain`);
      return { chain: false, triggerQA: true };
    } else {
      // Check if truly done (no generating, no qa_pending, no qa_processing, no pending)
      const { count: activeCount } = await supabase
        .from('generation_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batchId)
        .in('status', ['generating', 'qa_pending', 'qa_processing', 'pending']);

      if (!activeCount || activeCount === 0) {
        console.log('[process-next] All jobs done for batch:', batchId);
        await supabase
          .from('generation_batches')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', batchId);
      }
    }
    return { chain: false, triggerQA: false };
  }

  const job = jobs[0];
  const project = batch.project;
  const category = project?.category || 'textile';
  const strategy = getCategoryStrategy(category);
  const projectSettings = getProjectSettings(project?.metadata as Record<string, unknown> | null);
  const maxRetries = projectSettings.qa.max_retries;

  // ── ANTI-LOOP: if attempt >= max retries, flag directly ──
  if (job.attempt >= maxRetries) {
    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — attempt ${job.attempt} >= max ${MAX_QA_RETRIES}, flagging directly`
    );
    await supabase
      .from('generation_jobs')
      .update({
        status: 'flagged',
        error_message: `Max QA retries (${maxRetries}) reached without approval`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Update batch counters
    await supabase
      .from('generation_batches')
      .update({
        completed_count: (batch.completed_count || 0) + 1,
        flagged_count: (batch.flagged_count || 0) + 1,
      })
      .eq('id', batchId);

    return { chain: true, triggerQA: false };
  }

  try {
    // Download hero and swatch
    const [heroRes, swatchRes] = await Promise.all([
      supabase.storage.from('images').download(job.hero_shot.storage_path),
      supabase.storage.from('images').download(job.swatch.storage_path),
    ]);

    if (heroRes.error || swatchRes.error) {
      throw new Error(`Storage download failed: ${heroRes.error?.message || swatchRes.error?.message}`);
    }

    const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
    let swatchBuffer: Buffer = Buffer.from(await swatchRes.data.arrayBuffer());
    let heroBase64 = heroBuffer.toString('base64');

    // Check for additional swatch reference images
    const { data: extraImages } = await supabase
      .from('swatch_images')
      .select('storage_path')
      .eq('swatch_id', job.swatch.id)
      .order('display_order');

    let swatchImageCount = 1;
    if (extraImages && extraImages.length > 0) {
      // Download all extra images and create collage
      const allBuffers = [swatchBuffer];
      for (const img of extraImages) {
        const { data: imgData } = await supabase.storage.from('images').download(img.storage_path);
        if (imgData) {
          allBuffers.push(Buffer.from(await imgData.arrayBuffer()));
        }
      }
      if (allBuffers.length > 1) {
        swatchBuffer = await createSwatchCollage(allBuffers);
        swatchImageCount = allBuffers.length;
        console.log(`[process-next] Created swatch collage with ${allBuffers.length} images`);
      }
    }

    let swatchBase64 = swatchBuffer.toString('base64');

    // Detect dark swatches for prompt adjustments (use original swatch, not collage)
    const originalSwatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());
    const darkSwatch = await isSwatchDark(originalSwatchBuffer);
    if (darkSwatch) {
      console.log(`[process-next] Dark swatch: "${job.swatch.name}"`);
    }

    // ── Auto-analyze swatch color if missing ──
    // Uses Gemini Flash (~2s) to detect color, then caches in DB for future jobs
    let swatchColorDescription = job.swatch.color_description;
    if (!swatchColorDescription) {
      console.log(`[process-next] Swatch "${job.swatch.name}" has no color_description — auto-analyzing...`);
      try {
        const colorAnalysis = await analyzeSwatchColor(
          swatchBuffer.toString('base64'),
          job.swatch.mime_type || 'image/png'
        );
        if (colorAnalysis) {
          swatchColorDescription = colorAnalysis.colorDescription;
          console.log(`[process-next] Auto-detected color: "${swatchColorDescription}" (${colorAnalysis.dominantHex})`);
          // Cache in DB (non-blocking — don't let failure stop generation)
          Promise.resolve(
            supabase
              .from('swatches')
              .update({
                color_description: colorAnalysis.colorDescription,
                dominant_color_hex: colorAnalysis.dominantHex,
              })
              .eq('id', job.swatch.id)
          ).catch((err: unknown) => console.error('[process-next] Failed to cache swatch color:', err));
        }
      } catch (err) {
        console.error('[process-next] Swatch color analysis failed (non-blocking):', err);
      }
    }

    // ── Get QA feedback from previous attempt (for retries) ──
    const qaFeedback = job.attempt > 0 ? (job.qa_feedback || null) : null;
    if (qaFeedback) {
      console.log(`[process-next] Retry with QA feedback: "${qaFeedback}"`);
    }

    // ── Determine effective generation mode ──
    const effectiveMode = projectSettings.generation.mode !== 'auto'
      ? projectSettings.generation.mode
      : getEffectiveMode(strategy, job.attempt);
    const baseTemperature = getEffectiveTemperature(strategy, effectiveMode, job.attempt);
    // Use project temperature override if custom settings exist, otherwise use strategy default
    const temperature = projectSettings.generation.temperature !== 0.2
      ? projectSettings.generation.temperature
      : baseTemperature;

    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — ` +
      `category: ${category}, mode: ${effectiveMode}, attempt: ${job.attempt}, temp: ${temperature}` +
      `${swatchColorDescription ? `, color: ${swatchColorDescription}` : ''}`
    );

    // ── Preprocessing ──
    if (strategy.preprocessing.flatten_hero) {
      const flattenedHero = await flattenHeroEmboss(heroBuffer);
      heroBase64 = flattenedHero.toString('base64');
      console.log(`[process-next] Flattened hero emboss for ${category}`);
    }
    if (strategy.preprocessing.crop_swatch) {
      const croppedSwatch = await cropSwatchToFabric(swatchBuffer);
      swatchBase64 = croppedSwatch.toString('base64');
    }

    // ── Build prompt (with hex color anchor for color fidelity) ──
    const swatchHex = job.swatch.dominant_color_hex || null;
    let prompt = buildPromptForMode(
      effectiveMode,
      strategy,
      job.swatch.name,
      swatchColorDescription,
      job.hero_shot.shot_type,
      darkSwatch,
      qaFeedback,
      projectSettings.generation.resolution,
      swatchHex
    );

    // Add collage note if swatch has multiple reference images
    if (swatchImageCount > 1) {
      prompt += `\n\nNOTA IMPORTANTE SOBRE IMAGEN 2: La Imagen 2 es un COLLAGE con ${swatchImageCount} fotos de referencia del mismo producto. Muestra diferentes angulos, texturas y detalles del producto. Usa TODAS las fotos del collage para entender el color, patron, textura y detalles exactos del producto. El resultado debe ser fiel a lo que muestran estas referencias combinadas.`;
    }

    const promptMetadata: Record<string, unknown> = {
      strategy: `${effectiveMode}`,
      category,
      attempt: job.attempt,
      temperature,
      dark_swatch: darkSwatch,
      crop_swatch: strategy.preprocessing.crop_swatch,
      flatten_hero: strategy.preprocessing.flatten_hero,
      swatch_color: swatchColorDescription || null,
      swatch_hex: swatchHex,
      qa_feedback_used: qaFeedback ? true : false,
      swatch_image_count: swatchImageCount,
    };

    // Mark as generating
    await supabase
      .from('generation_jobs')
      .update({
        status: 'generating',
        prompt_text: prompt,
        attempt: job.attempt + 1,
        prompt_metadata: promptMetadata,
      })
      .eq('id', job.id);

    // ── Generate image based on mode ──
    let result;

    if (effectiveMode === 'from_scratch') {
      // From scratch: swatch only, no hero
      result = await generateImage({
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature,
      });
    } else {
      // Edit or Reference: hero + swatch
      result = await generateImage({
        heroImageBase64: heroBase64,
        heroMimeType: job.hero_shot.mime_type || 'image/png',
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature,
      });
    }

    if (!result.success || !result.imageBase64) {
      throw new Error(result.error || 'Generation failed');
    }

    // Post-process: ensure 1200x1200 RGB
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    const imageBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // Upload result — name includes SKU + color + shot type for searchability
    const sku = job.swatch?.sku_suffix || '';
    const color = (job.swatch?.name || '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    const shotType = (job.hero_shot?.shot_type || 'gen').replace(/[^a-zA-Z0-9]+/g, '-');
    const attempt = job.attempt + 1;
    const slug = [sku, color, shotType, `v${attempt}`].filter(Boolean).join('_');
    const outputPath = `projects/${project.id}/generated/${slug}_${job.id.substring(0, 8)}.png`;

    await supabase.storage
      .from('images')
      .upload(outputPath, imageBuffer, {
        contentType: result.imageMimeType || 'image/png',
        upsert: true,
      });

    // Mark job as qa_pending (NOT approved — QA will decide)
    await supabase
      .from('generation_jobs')
      .update({
        status: 'qa_pending',
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        gemini_model_used: process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview',
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Increment API call counter (non-blocking — column may not exist yet)
    Promise.resolve(
      supabase.from('generation_jobs')
        .update({ total_api_calls: (job.total_api_calls || 0) + 1 })
        .eq('id', job.id)
    ).catch(() => {});

    console.log(`[process-next] Job ${job.id.substring(0, 8)} done — status: qa_pending`);

    // Signal: chain to next + trigger QA
    return { chain: true, triggerQA: true };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await supabase
      .from('generation_batches')
      .update({
        completed_count: (batch.completed_count || 0) + 1,
        error_count: (batch.error_count || 0) + 1,
      })
      .eq('id', batchId);

    console.error(`[process-next] Job ${job.id.substring(0, 8)} error:`, errorMessage);

    // Still chain to try the next job
    return { chain: true, triggerQA: false };
  }
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

async function chainNext(batchId: string) {
  const baseUrl = getBaseUrl();
  const chainUrl = `${baseUrl}/api/batches/${batchId}/process-next`;
  console.log(`[process-next] Chaining to: ${chainUrl}`);

  try {
    await fetch(chainUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[process-next] Failed to chain next invocation:', err);
  }
}

async function triggerQAChain(batchId: string) {
  const baseUrl = getBaseUrl();
  const qaUrl = `${baseUrl}/api/batches/${batchId}/process-qa`;
  console.log(`[process-next] Triggering QA chain: ${qaUrl}`);

  try {
    await fetch(qaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[process-next] Failed to trigger QA chain:', err);
  }
}

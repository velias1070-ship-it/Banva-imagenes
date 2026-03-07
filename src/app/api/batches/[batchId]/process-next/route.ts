import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark, cropSwatchToFabric } from '@/lib/image-processing';
import {
  getCategoryStrategy,
  getEffectiveMode,
  getEffectiveTemperature,
  buildPromptForMode,
} from '@/lib/category-strategy';
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
 * QA is done by a separate chain (process-qa).
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  after(async () => {
    try {
      await processOneJob(batchId);
    } catch (err) {
      console.error('[process-next] Error:', err);
    }
  });

  return NextResponse.json({ status: 'processing' });
}

async function processOneJob(batchId: string) {
  const supabase = createAdminClient();

  // Get batch info
  const { data: batch } = await supabase
    .from('generation_batches')
    .select('*, project:projects(*)')
    .eq('id', batchId)
    .single();

  if (!batch) {
    console.log('[process-next] Batch not found:', batchId);
    return;
  }

  // Check if batch is halted
  if (batch.status === 'halted') {
    console.log('[process-next] Batch is halted, stopping chain:', batchId);
    return;
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
    // No more pending jobs — check if there are qa_pending jobs to process
    console.log('[process-next] No pending jobs for batch:', batchId);

    // Check for qa_pending jobs that need QA
    const { count: qaPendingCount } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'qa_pending');

    if (qaPendingCount && qaPendingCount > 0) {
      // Trigger QA chain
      console.log(`[process-next] ${qaPendingCount} qa_pending jobs — invoking process-qa`);
      const baseUrl = getBaseUrl();
      try {
        await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('[process-next] Failed to invoke process-qa:', err);
      }
    } else {
      // Truly done — finalize batch
      console.log('[process-next] All jobs done for batch:', batchId);
      await supabase
        .from('generation_batches')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', batchId);
    }
    return;
  }

  const job = jobs[0];
  const project = batch.project;
  const category = project?.category || 'textile';
  const strategy = getCategoryStrategy(category);

  // ── ANTI-LOOP: if attempt >= MAX_QA_RETRIES, flag directly ──
  if (job.attempt >= MAX_QA_RETRIES) {
    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — attempt ${job.attempt} >= max ${MAX_QA_RETRIES}, flagging directly`
    );
    await supabase
      .from('generation_jobs')
      .update({
        status: 'flagged',
        error_message: `Max QA retries (${MAX_QA_RETRIES}) reached without approval`,
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

    chainNext(batchId);
    return;
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
    const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());
    let heroBase64 = heroBuffer.toString('base64');
    let swatchBase64 = swatchBuffer.toString('base64');

    // Detect dark swatches for prompt adjustments
    const darkSwatch = await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[process-next] Dark swatch: "${job.swatch.name}"`);
    }

    // ── Determine effective generation mode ──
    const effectiveMode = getEffectiveMode(strategy, job.attempt);
    const temperature = getEffectiveTemperature(strategy, effectiveMode, job.attempt);

    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — ` +
      `category: ${category}, mode: ${effectiveMode}, attempt: ${job.attempt}, temp: ${temperature}`
    );

    // ── Preprocessing ──
    if (strategy.preprocessing.crop_swatch) {
      const croppedSwatch = await cropSwatchToFabric(swatchBuffer);
      swatchBase64 = croppedSwatch.toString('base64');
    }

    // ── Build prompt ──
    const prompt = buildPromptForMode(
      effectiveMode,
      strategy,
      job.swatch.name,
      job.swatch.color_description,
      job.hero_shot.shot_type,
      darkSwatch
    );

    const promptMetadata: Record<string, unknown> = {
      strategy: `${effectiveMode}`,
      category,
      attempt: job.attempt,
      temperature,
      dark_swatch: darkSwatch,
      crop_swatch: strategy.preprocessing.crop_swatch,
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

    // Upload result
    const outputPath = `projects/${project.id}/generated/${job.id}.png`;
    const imageBuffer = Buffer.from(result.imageBase64, 'base64');

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
  }

  // Chain: trigger next job
  chainNext(batchId);
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

function chainNext(batchId: string) {
  const baseUrl = getBaseUrl();
  const chainUrl = `${baseUrl}/api/batches/${batchId}/process-next`;
  console.log(`[process-next] Chaining to: ${chainUrl}`);

  fetch(chainUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => {
    console.error('[process-next] Failed to chain next invocation:', err);
  });
}

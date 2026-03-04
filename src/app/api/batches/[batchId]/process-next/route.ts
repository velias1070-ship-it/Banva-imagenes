import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark } from '@/lib/image-processing';

// Vercel serverless: max execution time — one job per invocation (~25s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * Process ONE pending job from a batch, then self-invoke for the next.
 * This "serverless chain" pattern keeps each invocation under 60s.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  // Use after() so we return immediately and process in background
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
    .limit(1);

  if (!jobs?.length) {
    // No more pending jobs — finalize batch
    console.log('[process-next] All jobs done for batch:', batchId);
    await supabase
      .from('generation_batches')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId);
    return;
  }

  const job = jobs[0];
  const project = batch.project;

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
    const heroBase64 = heroBuffer.toString('base64');
    const swatchBase64 = swatchBuffer.toString('base64');

    // Detect dark swatches for prompt adjustments
    const darkSwatch = await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[process-next] Dark swatch: "${job.swatch.name}"`);
    }

    // Import buildPrompt from generate route (single source of truth)
    const { buildPrompt } = await import('../../../projects/[id]/generate/route');

    const prompt = buildPrompt(
      project?.category || 'textile',
      job.swatch.name,
      job.swatch.color_description,
      job.hero_shot.shot_type,
      darkSwatch
    );

    // Mark as generating
    await supabase
      .from('generation_jobs')
      .update({ status: 'generating', prompt_text: prompt, attempt: job.attempt + 1 })
      .eq('id', job.id);

    // Call Gemini
    const result = await generateImage({
      heroImageBase64: heroBase64,
      heroMimeType: job.hero_shot.mime_type || 'image/png',
      swatchImageBase64: swatchBase64,
      swatchMimeType: 'image/png',
      promptText: prompt,
    });

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

    // Mark job as approved
    await supabase
      .from('generation_jobs')
      .update({
        status: 'approved',
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        gemini_model_used: process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview',
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Update batch progress
    await supabase
      .from('generation_batches')
      .update({
        completed_count: (batch.completed_count || 0) + 1,
        approved_count: (batch.approved_count || 0) + 1,
      })
      .eq('id', batchId);

    console.log(`[process-next] Job ${job.id.substring(0, 8)} done — triggering next`);

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

  // Chain: trigger next job via self-invocation
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_SUPABASE_URL
      ? 'http://localhost:3000'
      : 'http://localhost:3000';

  try {
    await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    console.error('[process-next] Failed to chain next invocation');
  }
}

import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark, cropSwatchToFabric } from '@/lib/image-processing';
import {
  getCategoryStrategy,
  getEffectiveTemperature,
  buildPromptForMode,
  type GenerationMode,
} from '@/lib/category-strategy';

// Vercel serverless: max execution time (free=60s, pro=300s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { status } = body;

  if (!['approved', 'flagged', 'retry'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const { data: job, error } = await supabase
    .from('generation_jobs')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(job);
}

// Regenerate a single job
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, jobId } = await context.params;
  const supabase = createAdminClient();

  // Get job with relations
  const { data: job, error: jobError } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Get project for category
  const { data: project } = await supabase
    .from('projects')
    .select('category')
    .eq('id', id)
    .single();

  // Mark as generating (prevents QA from writing stale results)
  await supabase
    .from('generation_jobs')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  // Use after() to keep serverless function alive for background regeneration
  after(async () => {
    try {
      await regenerateJob(jobId, job, project?.category || 'textile', id);
    } catch (err) {
      console.error('Regeneration error:', err);
    }
  });

  return NextResponse.json({ status: 'generating' });
}

async function regenerateJob(
  jobId: string,
  job: Record<string, unknown>,
  category: string,
  projectId: string
) {
  const supabase = createAdminClient();
  const heroShot = job.hero_shot as Record<string, string>;
  const swatch = job.swatch as Record<string, string>;
  const strategy = getCategoryStrategy(category);

  // Determine mode — check if QA flagged hero_contamination
  let mode: GenerationMode = strategy.generation_mode;
  const qaDetail = job.qa_detail as Record<string, number> | null;
  const attempt = (job.attempt as number) || 0;

  if (qaDetail?.hero_contamination && qaDetail.hero_contamination > 0.6 && strategy.retry_escalation) {
    // Hero contamination detected — escalate
    mode = strategy.retry_escalation;
    console.log(
      `[regenerateJob] Hero contamination ${(qaDetail.hero_contamination * 100).toFixed(0)}% — ` +
      `escalating from ${strategy.generation_mode} to ${mode}`
    );
  } else if (attempt > 0 && strategy.retry_escalation) {
    // Previous attempt failed — use retry escalation
    mode = strategy.retry_escalation;
    console.log(`[regenerateJob] Retry attempt ${attempt} — using ${mode}`);
  }

  const temperature = getEffectiveTemperature(strategy, mode, attempt);

  try {
    // Download hero and swatch
    const [heroRes, swatchRes] = await Promise.all([
      supabase.storage.from('images').download(heroShot.storage_path),
      supabase.storage.from('images').download(swatch.storage_path),
    ]);

    if (heroRes.error || swatchRes.error) {
      throw new Error(`Storage download failed`);
    }

    const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
    const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());

    // Detect dark swatches for prompt adjustments
    const darkSwatch = await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[regenerateJob] Dark swatch detected: "${swatch.name}"`);
    }

    // Preprocessing
    let swatchBase64 = swatchBuffer.toString('base64');
    if (strategy.preprocessing.crop_swatch) {
      const croppedSwatch = await cropSwatchToFabric(swatchBuffer);
      swatchBase64 = croppedSwatch.toString('base64');
    }

    // Build prompt
    const prompt = buildPromptForMode(
      mode,
      strategy,
      swatch.name,
      swatch.color_description || null,
      heroShot.shot_type,
      darkSwatch
    );

    const promptMetadata: Record<string, unknown> = {
      strategy: mode,
      category,
      attempt,
      temperature,
      dark_swatch: darkSwatch,
      crop_swatch: strategy.preprocessing.crop_swatch,
      manual_regeneration: true,
    };

    // Generate
    let result;

    if (mode === 'from_scratch') {
      result = await generateImage({
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature,
      });
    } else {
      const heroBase64 = heroBuffer.toString('base64');
      result = await generateImage({
        heroImageBase64: heroBase64,
        heroMimeType: heroShot.mime_type || 'image/png',
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
    const outputPath = `projects/${projectId}/generated/${jobId}.png`;
    const imageBuffer = Buffer.from(result.imageBase64, 'base64');

    await supabase.storage
      .from('images')
      .upload(outputPath, imageBuffer, {
        contentType: result.imageMimeType || 'image/png',
        upsert: true,
      });

    // Mark as qa_pending (QA will evaluate asynchronously)
    await supabase
      .from('generation_jobs')
      .update({
        status: 'qa_pending',
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        attempt: attempt + 1,
        prompt_text: prompt,
        prompt_metadata: promptMetadata,
        total_api_calls: ((job.total_api_calls as number) || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Trigger QA for this job
    const baseUrl = process.env.APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      || 'http://localhost:3000';

    // Get batch_id from the job to invoke QA chain
    const batchId = job.batch_id as string;
    if (batchId) {
      try {
        await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        console.log(`[regenerateJob] Triggered QA for batch ${batchId}`);
      } catch (err) {
        console.error('[regenerateJob] Failed to trigger QA:', err);
      }
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: errorMessage,
        total_api_calls: ((job.total_api_calls as number) || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

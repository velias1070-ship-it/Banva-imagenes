import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark } from '@/lib/image-processing';

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

  // Mark as generating
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
  // Import buildPrompt directly — single source of truth for prompt construction
  const { buildPrompt } = await import('../../generate/route');

  const supabase = createAdminClient();
  const heroShot = job.hero_shot as Record<string, string>;
  const swatch = job.swatch as Record<string, string>;

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
    const heroBase64 = heroBuffer.toString('base64');
    const swatchBase64 = swatchBuffer.toString('base64');

    // Detect dark swatches for prompt adjustments (no image enhancement)
    const darkSwatch = await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[regenerateJob] Dark swatch detected: "${swatch.name}" — using dark-fabric prompt`);
    }

    // Use the SAME buildPrompt function as batch generation — no duplication
    const prompt = buildPrompt(
      category,
      swatch.name,
      swatch.color_description || null,
      heroShot.shot_type,
      darkSwatch
    );

    // Call Gemini with original swatch (dark swatches get adjusted prompt, not enhanced image)
    const result = await generateImage({
      heroImageBase64: heroBase64,
      heroMimeType: heroShot.mime_type || 'image/png',
      swatchImageBase64: swatchBase64,
      swatchMimeType: 'image/png',
      promptText: prompt,
    });

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

    // Mark as approved
    await supabase
      .from('generation_jobs')
      .update({
        status: 'approved',
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        attempt: (job.attempt as number || 0) + 1,
        prompt_text: prompt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

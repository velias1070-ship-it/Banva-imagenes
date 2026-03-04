import { inngest } from '../client';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { DELAY_BETWEEN_REQUESTS_SEC } from '@/lib/constants';

export const batchGenerate = inngest.createFunction(
  {
    id: 'batch-generate',
    retries: 2,
    throttle: {
      limit: 9,
      period: '1m',
    },
  },
  { event: 'banva/batch.generate' },
  async ({ event, step }) => {
    const { batchId, projectId } = event.data;
    const supabase = createAdminClient();

    // Update batch status to generating
    await step.run('update-batch-status', async () => {
      await supabase
        .from('generation_batches')
        .update({ status: 'generating', started_at: new Date().toISOString() })
        .eq('id', batchId);
    });

    // Get all pending jobs
    const jobs = await step.run('fetch-jobs', async () => {
      const { data } = await supabase
        .from('generation_jobs')
        .select(`
          *,
          hero_shot:hero_shots(*),
          swatch:swatches(*)
        `)
        .eq('batch_id', batchId)
        .eq('status', 'pending');
      return data || [];
    });

    // Get project for category context
    const project = await step.run('fetch-project', async () => {
      const { data } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single();
      return data;
    });

    let completedCount = 0;
    let approvedCount = 0;
    let flaggedCount = 0;
    let errorCount = 0;

    // Process each job sequentially with rate limiting
    for (const job of jobs) {
      await step.run(`generate-${job.id}`, async () => {
        try {
          // Download hero and swatch images from Supabase Storage
          const [heroRes, swatchRes] = await Promise.all([
            supabase.storage.from('images').download(job.hero_shot.storage_path),
            supabase.storage.from('images').download(job.swatch.storage_path),
          ]);

          if (heroRes.error || swatchRes.error) {
            throw new Error('Failed to download images from storage');
          }

          const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
          const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());

          const heroBase64 = heroBuffer.toString('base64');
          const swatchBase64 = swatchBuffer.toString('base64');

          // Build prompt
          const prompt = buildPrompt(
            project?.category || 'general',
            job.swatch.name,
            job.swatch.color_description,
            job.hero_shot.shot_type
          );

          // Update job to generating
          await supabase
            .from('generation_jobs')
            .update({ status: 'generating', prompt_text: prompt, attempt: job.attempt + 1 })
            .eq('id', job.id);

          // Call Gemini API
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

          // Upload generated image to storage
          const outputPath = `projects/${project?.id}/generated/${job.id}.png`;
          const imageBuffer = Buffer.from(result.imageBase64, 'base64');

          await supabase.storage
            .from('images')
            .upload(outputPath, imageBuffer, {
              contentType: result.imageMimeType || 'image/png',
              upsert: true,
            });

          // Update job as approved (QA will refine this later)
          await supabase
            .from('generation_jobs')
            .update({
              status: 'approved',
              output_storage_path: outputPath,
              generation_time_ms: result.durationMs,
              gemini_model_used: process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview',
            })
            .eq('id', job.id);

          completedCount++;
          approvedCount++;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          await supabase
            .from('generation_jobs')
            .update({
              status: 'error',
              error_message: errorMessage,
            })
            .eq('id', job.id);

          errorCount++;
          completedCount++;
        }

        // Update batch progress
        await supabase
          .from('generation_batches')
          .update({
            completed_count: completedCount,
            approved_count: approvedCount,
            flagged_count: flaggedCount,
            error_count: errorCount,
          })
          .eq('id', batchId);
      });

      // Rate limit delay between requests
      await step.sleep(`delay-${job.id}`, `${DELAY_BETWEEN_REQUESTS_SEC}s`);
    }

    // Final batch update
    await step.run('finalize-batch', async () => {
      await supabase
        .from('generation_batches')
        .update({
          status: 'completed',
          completed_count: completedCount,
          approved_count: approvedCount,
          flagged_count: flaggedCount,
          error_count: errorCount,
          completed_at: new Date().toISOString(),
        })
        .eq('id', batchId);
    });

    return { completedCount, approvedCount, flaggedCount, errorCount };
  }
);

function buildPrompt(
  category: string,
  swatchName: string,
  colorDescription: string | null,
  shotType: string
): string {
  const colorInfo = colorDescription ? ` (${colorDescription})` : '';

  return `You are a professional product photographer for a textile e-commerce company.

IMAGE 1 (Hero Shot): This is the base product photo - a ${category} in a ${shotType} shot.
IMAGE 2 (Swatch): This is the target color/design variant called "${swatchName}"${colorInfo}.

YOUR TASK:
Generate a new image that is IDENTICAL to Image 1 in every way (composition, lighting, angles, models, props, environment, shadows) but with the product's fabric/textile changed to match EXACTLY the color, pattern, and design shown in Image 2 (the swatch).

CRITICAL RULES:
1. PRODUCT FIDELITY: The product shape, folds, draping, and texture must match Image 1 exactly
2. DESIGN ACCURACY: The color/pattern must match Image 2 exactly - do NOT invent or modify the design
3. ENVIRONMENT PRESERVATION: Background, lighting, props, models must remain identical to Image 1
4. NO INVENTIONS: Do not add, remove, or modify ANY element that isn't the fabric design change
5. QUALITY: Professional e-commerce quality, sharp details, accurate colors

Generate the image at 1024x1024 resolution.`;
}

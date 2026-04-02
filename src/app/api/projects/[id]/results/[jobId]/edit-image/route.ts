import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { ensureOutputSpec } from '@/lib/image-processing';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

/**
 * POST — Edit an approved image with a free-text instruction.
 * Body: { instruction: "cambia 1 plaza por 2 plazas" }
 *
 * Takes the approved image, sends it to Gemini with the instruction,
 * creates a new job with the edited result.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId, jobId } = await context.params;
  const supabase = createAdminClient();
  const body = await request.json();
  const instruction = (body.instruction || '').trim();

  if (!instruction) {
    return NextResponse.json({ error: 'instruction is required' }, { status: 400 });
  }

  // Get original job
  const { data: originalJob } = await supabase
    .from('generation_jobs')
    .select('*, hero_shot:hero_shots(*), swatch:swatches(*)')
    .eq('id', jobId)
    .single();

  if (!originalJob?.output_storage_path) {
    return NextResponse.json({ error: 'Job not found or has no image' }, { status: 404 });
  }

  // Create new job
  const { data: newJob, error: insertError } = await supabase
    .from('generation_jobs')
    .insert({
      batch_id: originalJob.batch_id,
      hero_shot_id: originalJob.hero_shot_id,
      swatch_id: originalJob.swatch_id,
      status: 'generating',
      attempt: 0,
      prompt_metadata: {
        strategy: 'edit_instruction',
        source_job_id: jobId,
        instruction,
      },
    })
    .select()
    .single();

  if (insertError || !newJob) {
    return NextResponse.json({ error: insertError?.message || 'Failed to create job' }, { status: 500 });
  }

  // Re-activate batch
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', originalJob.batch_id);

  // Process in background
  after(async () => {
    try {
      // Download the approved image
      const { data: imgData } = await supabase.storage
        .from('images')
        .download(originalJob.output_storage_path);

      if (!imgData) throw new Error('Failed to download source image');

      const imageBuffer = Buffer.from(await imgData.arrayBuffer());
      const imageBase64 = imageBuffer.toString('base64');

      // Build prompt with user instruction
      const prompt = `Edita esta imagen siguiendo esta instruccion:

"${instruction}"

REGLAS:
- Aplica SOLO el cambio solicitado
- Mantiene todo lo demas IDENTICO (composicion, fondo, estilo, calidad)
- Si el cambio involucra texto, el resultado debe estar en ESPAÑOL
- No inventes elementos nuevos que no se pidieron
- La imagen debe mantener calidad fotografica profesional`;

      // Send to Gemini — image as hero, no swatch needed
      const result = await generateImage({
        heroImageBase64: imageBase64,
        heroMimeType: 'image/png',
        // Use same image as "swatch" since Gemini requires it
        swatchImageBase64: imageBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature: 0.3,
      });

      if (!result.success || !result.imageBase64) {
        throw new Error(result.error || 'Edit failed');
      }

      // Post-process
      const rawBuffer = Buffer.from(result.imageBase64, 'base64');
      const processedBuffer = await ensureOutputSpec(rawBuffer, 1200);

      // Upload
      const outputPath = `projects/${projectId}/generated/${newJob.id}.png`;
      await supabase.storage.from('images').upload(outputPath, processedBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

      // Update job
      await supabase
        .from('generation_jobs')
        .update({
          status: 'approved', // Skip QA for manual edits
          output_storage_path: outputPath,
          generation_time_ms: result.durationMs,
          prompt_text: prompt,
          qa_score: 1.0,
          prompt_metadata: {
            strategy: 'edit_instruction',
            source_job_id: jobId,
            instruction,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', newJob.id);

      console.log(`[edit-image] Done: ${newJob.id} — "${instruction}"`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('generation_jobs')
        .update({
          status: 'error',
          error_message: `edit-image: ${msg}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', newJob.id);
      console.error(`[edit-image] Error:`, msg);
    }
  });

  return NextResponse.json({ status: 'generating', new_job_id: newJob.id });
}

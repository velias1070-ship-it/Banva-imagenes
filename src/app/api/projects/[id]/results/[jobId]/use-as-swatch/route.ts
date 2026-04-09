import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { id: projectId, jobId } = await context.params;
  const supabase = createAdminClient();

  // Get the job with its swatch
  const { data: job } = await supabase
    .from('generation_jobs')
    .select('output_storage_path, swatch_id')
    .eq('id', jobId)
    .single();

  if (!job?.output_storage_path || !job?.swatch_id) {
    return NextResponse.json({ error: 'Job not found or no output' }, { status: 404 });
  }

  // Download the generated image
  const { data: imageData } = await supabase.storage
    .from('images')
    .download(job.output_storage_path);

  if (!imageData) {
    return NextResponse.json({ error: 'Could not download output image' }, { status: 500 });
  }

  const imageBuffer = Buffer.from(await imageData.arrayBuffer());

  // Upload as new swatch image
  const newSwatchPath = `projects/${projectId}/swatches/${job.swatch_id}_from_result.png`;
  await supabase.storage
    .from('images')
    .upload(newSwatchPath, imageBuffer, { contentType: 'image/png', upsert: true });

  // Update swatch to use this image
  await supabase
    .from('swatches')
    .update({
      storage_path: newSwatchPath,
      color_description: null,  // needs re-analysis
    })
    .eq('id', job.swatch_id);

  // Clear cached flat swatch (outdated now)
  await supabase
    .from('swatch_images')
    .delete()
    .eq('swatch_id', job.swatch_id)
    .eq('label', 'flat');

  return NextResponse.json({
    success: true,
    swatch_id: job.swatch_id,
    new_path: newSwatchPath,
  });
}

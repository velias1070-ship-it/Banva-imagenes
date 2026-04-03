import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { detectShotType } from '@/lib/shot-type-detector';

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

/**
 * POST — Save a generated image as a new hero shot for the project.
 * Copies the image to heroes storage and creates a hero_shots record.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id: projectId, jobId } = await context.params;
  const supabase = createAdminClient();

  // Get the job with its generated image
  const { data: job } = await supabase
    .from('generation_jobs')
    .select('output_storage_path, swatch:swatches(name)')
    .eq('id', jobId)
    .single();

  if (!job?.output_storage_path) {
    return NextResponse.json({ error: 'Job not found or has no image' }, { status: 404 });
  }

  // Download the generated image
  const { data: imageData, error: dlError } = await supabase.storage
    .from('images')
    .download(job.output_storage_path);

  if (dlError || !imageData) {
    return NextResponse.json({ error: 'Failed to download image' }, { status: 500 });
  }

  const buffer = Buffer.from(await imageData.arrayBuffer());

  // Detect shot type
  let shotType = 'lifestyle';
  try {
    const base64 = buffer.toString('base64');
    const detection = await detectShotType(base64, 'image/png');
    if (detection && detection.confidence >= 0.7) {
      shotType = detection.detected_type;
    }
  } catch { /* use default */ }

  // Upload to heroes storage path
  const heroId = crypto.randomUUID();
  const swatchName = (job.swatch as Record<string, string>)?.name || 'variant';
  const filename = `${swatchName.replace(/\s+/g, '-')}_${shotType}.png`;
  const storagePath = `projects/${projectId}/heroes/${heroId}.png`;

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, {
      contentType: 'image/png',
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Get next display_order
  const { data: existing } = await supabase
    .from('hero_shots')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  // Create hero_shots record
  const { data: hero, error: insertError } = await supabase
    .from('hero_shots')
    .insert({
      project_id: projectId,
      filename,
      storage_path: storagePath,
      shot_type: shotType,
      display_order: nextOrder,
      file_size_kb: Math.round(buffer.length / 1024),
      mime_type: 'image/png',
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  console.log(`[save-as-hero] Saved job ${jobId} as hero ${heroId} (${filename}, ${shotType})`);

  return NextResponse.json({
    hero_id: hero.id,
    filename,
    shot_type: shotType,
    storage_path: storagePath,
  });
}

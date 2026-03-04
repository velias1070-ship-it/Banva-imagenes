import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import archiver from 'archiver';
import { PassThrough } from 'stream';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createAdminClient();
  const jobId = request.nextUrl.searchParams.get('jobId');

  // Single image download
  if (jobId) {
    const { data: job } = await supabase
      .from('generation_jobs')
      .select(`
        output_storage_path,
        hero_shot:hero_shots(filename),
        swatch:swatches(name)
      `)
      .eq('id', jobId)
      .single();

    if (!job?.output_storage_path) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }

    const { data: fileData, error } = await supabase.storage
      .from('images')
      .download(job.output_storage_path);

    if (error || !fileData) {
      return NextResponse.json({ error: 'Failed to download from storage' }, { status: 500 });
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const heroName = (job.hero_shot as { filename: string })?.filename?.replace(/\.[^.]+$/, '') || 'hero';
    const swatchName = (job.swatch as { name: string })?.name || 'variant';
    const filename = `${heroName}_${swatchName}.png`.replace(/[^a-zA-Z0-9._-]/g, '_');

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  // ZIP download - all approved from this project
  const { data: project } = await supabase
    .from('projects')
    .select('slug')
    .eq('id', id)
    .single();

  // Get ALL approved jobs across all batches for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', id);

  if (!batches?.length) {
    return NextResponse.json({ error: 'No batches found' }, { status: 404 });
  }

  const batchIds = batches.map((b) => b.id);

  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select(`
      id,
      output_storage_path,
      hero_shot:hero_shots(filename),
      swatch:swatches(name)
    `)
    .in('batch_id', batchIds)
    .eq('status', 'approved');

  // Filter out jobs without output path
  const validJobs = (jobs || []).filter((j) => j.output_storage_path);

  if (!validJobs.length) {
    return NextResponse.json({ error: 'No approved images to download' }, { status: 404 });
  }

  // Build ZIP
  const chunks: Buffer[] = [];
  const passthrough = new PassThrough();
  passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));

  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1 = fast, images already compressed
  archive.pipe(passthrough);

  for (const job of validJobs) {
    const { data: fileData, error } = await supabase.storage
      .from('images')
      .download(job.output_storage_path!);

    if (error || !fileData) continue;

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const heroName = (job.hero_shot as { filename: string })?.filename?.replace(/\.[^.]+$/, '') || 'hero';
    const swatchName = (job.swatch as { name: string })?.name || 'variant';
    const filename = `${heroName}_${swatchName}.png`.replace(/[^a-zA-Z0-9._-]/g, '_');

    archive.append(buffer, { name: filename });
  }

  await archive.finalize();
  await new Promise<void>((resolve) => passthrough.on('end', resolve));

  const zipBuffer = Buffer.concat(chunks);
  const projectName = project?.slug || 'banva-project';

  return new NextResponse(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${projectName}-approved.zip"`,
    },
  });
}

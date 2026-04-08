import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();

  const body = await request.json();
  const { source_swatch_id, target_swatch_ids } = body;

  if (!source_swatch_id || !target_swatch_ids?.length) {
    return NextResponse.json({ error: 'source_swatch_id and target_swatch_ids required' }, { status: 400 });
  }

  // Get project info
  const { data: project } = await supabase
    .from('projects')
    .select('name, category, brand_id')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get all batch IDs for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);

  if (!batches?.length) {
    return NextResponse.json({ error: 'No batches found for this project' }, { status: 400 });
  }

  const batchIds = batches.map((b) => b.id);

  // Find all approved jobs for the source swatch in this project's batches
  const { data: sourceJobs } = await supabase
    .from('generation_jobs')
    .select('hero_shot_id, prompt_adjustment')
    .eq('status', 'approved')
    .eq('swatch_id', source_swatch_id)
    .not('hero_shot_id', 'is', null)
    .in('batch_id', batchIds);

  if (!sourceJobs?.length) {
    return NextResponse.json({ error: 'No approved results found for source swatch' }, { status: 400 });
  }

  // Get unique hero_shot_ids from approved source jobs
  const heroIds = [...new Set(sourceJobs.map((j) => j.hero_shot_id).filter(Boolean))] as string[];
  const skipBrandHeroIds = sourceJobs
    .filter((j) => j.prompt_adjustment === 'SKIP_BRAND')
    .map((j) => j.hero_shot_id)
    .filter(Boolean) as string[];

  const totalCombinations = heroIds.length * target_swatch_ids.length;

  // Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'pending',
      total_combinations: totalCombinations,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: totalCombinations * COST_PER_IMAGE_USD,
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
  }

  // Create jobs for each hero x target swatch
  const skipBrandSet = new Set(skipBrandHeroIds);
  const jobs = target_swatch_ids.flatMap((swatchId: string) =>
    heroIds.map((heroId) => ({
      batch_id: batch.id,
      hero_shot_id: heroId,
      swatch_id: swatchId,
      status: 'pending' as const,
      attempt: 0,
      ...(skipBrandSet.has(heroId) ? { prompt_adjustment: 'SKIP_BRAND' } : {}),
    }))
  );

  const { error: jobsError } = await supabase
    .from('generation_jobs')
    .insert(jobs);

  if (jobsError) {
    return NextResponse.json({ error: 'Failed to create jobs' }, { status: 500 });
  }

  // Update batch status and trigger processing
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', started_at: new Date().toISOString() })
    .eq('id', batch.id);

  // Trigger process-next chain
  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  fetch(`${baseUrl}/api/batches/${batch.id}/process-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => {});

  return NextResponse.json({
    batch_id: batch.id,
    total_jobs: totalCombinations,
    heroes: heroIds.length,
    target_swatches: target_swatch_ids.length,
    estimated_cost_usd: totalCombinations * COST_PER_IMAGE_USD,
  });
}

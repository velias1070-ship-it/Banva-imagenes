import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function startBatchProcessing(batchId: string) {
  const supabase = createAdminClient();
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', started_at: new Date().toISOString() })
    .eq('id', batchId);

  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => {
    console.error('[brand-regen] Failed to trigger process-next:', err);
  });
}

/**
 * POST /api/projects/{id}/brand-regen
 *
 * Takes existing hero shots and regenerates them with brand applied.
 * For each hero, creates a temporary swatch (same image) to satisfy
 * the pipeline, then processes with BRAND_ONLY prompt.
 *
 * Body: { hero_ids?: string[], brand_id?: string }
 * - hero_ids: optional filter, defaults to ALL heroes
 * - brand_id: optional override, defaults to project's brand
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));

  const supabase = createAdminClient();

  // 1. Get project & validate brand
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, brand_id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const brandId = body.brand_id || project.brand_id;
  if (!brandId) {
    return NextResponse.json({ error: 'No brand assigned. Set a brand in project settings first.' }, { status: 400 });
  }

  if (body.brand_id && body.brand_id !== project.brand_id) {
    await supabase.from('projects').update({ brand_id: body.brand_id }).eq('id', projectId);
  }

  const { data: brand } = await supabase.from('brands').select('id, name').eq('id', brandId).single();
  if (!brand) {
    return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
  }

  // 2. Get heroes (optionally filtered)
  const heroFilterIds: string[] | undefined = body.hero_ids;
  let heroQuery = supabase
    .from('hero_shots')
    .select('id, filename, storage_path, shot_type, mime_type')
    .eq('project_id', projectId);

  if (heroFilterIds?.length) {
    heroQuery = heroQuery.in('id', heroFilterIds);
  }

  const { data: heroes } = await heroQuery.order('display_order');

  if (!heroes?.length) {
    return NextResponse.json({ error: 'No hero shots found. Upload images first.' }, { status: 400 });
  }

  // 3. Get target swatch (the variant these heroes belong to)
  const targetSwatchId: string | undefined = body.target_swatch_id;

  let targetSwatch: { id: string; storage_path: string | null } | null = null;

  if (targetSwatchId) {
    const { data } = await supabase.from('swatches').select('id, storage_path').eq('id', targetSwatchId).single();
    targetSwatch = data;
  } else {
    // Fall back to first swatch in project
    const { data } = await supabase.from('swatches').select('id, storage_path').eq('project_id', projectId).order('display_order').limit(1).single();
    targetSwatch = data;
  }

  if (!targetSwatch) {
    return NextResponse.json({ error: 'No target swatch found' }, { status: 400 });
  }

  // Ensure swatch has a storage_path (use first hero's image if missing)
  if (!targetSwatch.storage_path && heroes.length > 0) {
    await supabase.from('swatches').update({ storage_path: heroes[0].storage_path }).eq('id', targetSwatch.id);
  }

  // Pair all heroes with the same target swatch
  const jobRows = heroes.map((hero) => ({ heroId: hero.id, swatchId: targetSwatch!.id }));

  // 4. Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'pending',
      total_combinations: jobRows.length,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: jobRows.length * COST_PER_IMAGE_USD,
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });
  }

  // 5. Create jobs with BRAND_ONLY flag
  const jobs = jobRows.map((pair) => ({
    batch_id: batch.id,
    hero_shot_id: pair.heroId,
    swatch_id: pair.swatchId,
    status: 'pending' as const,
    attempt: 0,
    prompt_adjustment: 'BRAND_ONLY',
  }));

  const { error: jobsError } = await supabase.from('generation_jobs').insert(jobs);
  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  // 6. Start processing
  after(async () => {
    try {
      await startBatchProcessing(batch.id);
    } catch (err) {
      console.error('[brand-regen] Background processing error:', err);
    }
  });

  return NextResponse.json({
    batch_id: batch.id,
    brand: brand.name,
    total_jobs: jobRows.length,
    heroes_processed: heroes.length,
  }, { status: 201 });
}

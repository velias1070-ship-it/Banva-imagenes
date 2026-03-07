import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';

// Vercel serverless: max execution time (free=60s, pro=300s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: Category rules, prompt builders, and shot compositions have been
// extracted to src/lib/category-strategy.ts (single source of truth).
// The old getCategoryRule(), buildPrompt(), buildGenerationPrompt(), and
// getShotTypeComposition() functions are no longer here.
// ─────────────────────────────────────────────────────────────────────────────

// Start batch processing: update status and trigger the chain of one-at-a-time invocations
async function startBatchProcessing(batchId: string) {
  const supabase = createAdminClient();

  // Update batch to generating
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', started_at: new Date().toISOString() })
    .eq('id', batchId);

  // Trigger the first job via the process-next endpoint (serverless chain)
  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';

  console.log(`[startBatch] Triggering process-next chain for batch ${batchId}`);

  await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => {
    console.error('[startBatch] Failed to trigger process-next:', err);
  });
}

// GET: Return heroes with their generation status (how many jobs completed per hero)
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createAdminClient();

  // Get all heroes for this project
  const { data: heroes } = await supabase
    .from('hero_shots')
    .select('id, filename, shot_type, storage_path, display_order')
    .eq('project_id', id)
    .order('display_order');

  if (!heroes?.length) {
    return NextResponse.json([]);
  }

  // Get swatches count
  const { count: swatchCount } = await supabase
    .from('swatches')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', id);

  // Get all batches for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', id);

  const batchIds = batches?.map((b) => b.id) || [];

  // Get job counts per hero (across all batches)
  const jobsByHero: Record<string, { total: number; approved: number }> = {};

  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('hero_shot_id, status')
      .in('batch_id', batchIds);

    if (jobs) {
      for (const job of jobs) {
        if (!jobsByHero[job.hero_shot_id]) {
          jobsByHero[job.hero_shot_id] = { total: 0, approved: 0 };
        }
        jobsByHero[job.hero_shot_id].total++;
        if (job.status === 'approved') {
          jobsByHero[job.hero_shot_id].approved++;
        }
      }
    }
  }

  const heroesWithStatus = heroes.map((hero) => ({
    ...hero,
    total_jobs: jobsByHero[hero.id]?.total || 0,
    approved_jobs: jobsByHero[hero.id]?.approved || 0,
    swatches_count: swatchCount || 0,
  }));

  return NextResponse.json(heroesWithStatus);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  // Read optional hero_ids and swatch_ids from body
  const body = await request.json().catch(() => ({}));
  const heroIds: string[] | undefined = body.hero_ids;
  const swatchIds: string[] | undefined = body.swatch_ids;

  // Get project
  const { data: project, error: projError } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (projError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get heroes and swatches
  const [{ data: allHeroes }, { data: swatches }] = await Promise.all([
    supabase.from('hero_shots').select('*').eq('project_id', id).order('display_order'),
    supabase.from('swatches').select('*').eq('project_id', id).order('display_order'),
  ]);

  if (!allHeroes?.length) {
    return NextResponse.json({ error: 'No hero shots uploaded' }, { status: 400 });
  }
  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches uploaded' }, { status: 400 });
  }

  // Filter heroes if specific ones were selected
  const selectedHeroes = heroIds?.length
    ? allHeroes.filter((h) => heroIds.includes(h.id))
    : allHeroes;

  if (!selectedHeroes.length) {
    return NextResponse.json({ error: 'No matching heroes found' }, { status: 400 });
  }

  // Filter swatches if specific ones were selected
  const selectedSwatches = swatchIds?.length
    ? swatches.filter((s) => swatchIds.includes(s.id))
    : swatches;

  if (!selectedSwatches.length) {
    return NextResponse.json({ error: 'No matching swatches found' }, { status: 400 });
  }

  const totalCombinations = selectedHeroes.length * selectedSwatches.length;

  // Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: id,
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
    return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });
  }

  // Create individual jobs for selected heroes x selected swatches
  const jobs = selectedHeroes.flatMap((hero) =>
    selectedSwatches.map((swatch) => ({
      batch_id: batch.id,
      hero_shot_id: hero.id,
      swatch_id: swatch.id,
      status: 'pending' as const,
      attempt: 0,
    }))
  );

  const { error: jobsError } = await supabase
    .from('generation_jobs')
    .insert(jobs);

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  // Start the serverless chain: one job per invocation, each under 60s
  after(async () => {
    try {
      await startBatchProcessing(batch.id);
    } catch (err) {
      console.error('Background processing error:', err);
    }
  });

  return NextResponse.json(batch, { status: 201 });
}

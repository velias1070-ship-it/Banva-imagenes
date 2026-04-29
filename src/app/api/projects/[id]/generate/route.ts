import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';
import {
  anyHeroHasTags,
  extractSizeFromSku,
  resolveHeroesForVariant,
  type ProjectVariant,
} from '@/lib/sku-parser';

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
    .select('id, filename, shot_type, storage_path, display_order, applies_to_designs, applies_to_sizes')
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

  // Backward-compatible: clients that send ?with_meta=1 also receive the
  // resolver metadata (project variantes) so they can preview combinations.
  const url = new URL(_request.url);
  if (url.searchParams.get('with_meta') === '1') {
    const { data: project } = await supabase
      .from('projects')
      .select('metadata')
      .eq('id', id)
      .single();
    const variantes =
      ((project?.metadata as { variantes?: unknown } | null)?.variantes as unknown[]) || [];
    return NextResponse.json({ heroes: heroesWithStatus, variantes });
  }

  return NextResponse.json(heroesWithStatus);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  // Read optional hero_ids and swatch_ids from body
  const body = await request.json().catch(() => ({}));
  const heroIds: string[] | undefined = body.hero_ids;
  const swatchIds: string[] | undefined = body.swatch_ids;
  const skipBrandHeroIds: string[] = body.skip_brand_hero_ids || [];

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

  // Decide job creation strategy:
  //   - If at least one selected hero has design/size tags AND the project has
  //     resolved variantes (multi-tamano like limpiapies/alfombras), use the
  //     resolver: 1 job per swatch with the best-matching hero.
  //   - Otherwise, fall back to legacy cross product (heroes x swatches).
  const useResolver =
    anyHeroHasTags(selectedHeroes) &&
    Array.isArray((project.metadata as { variantes?: ProjectVariant[] } | null)?.variantes);

  const variantes = useResolver
    ? ((project.metadata as { variantes: ProjectVariant[] }).variantes)
    : [];
  const variantBySku = new Map(variantes.map((v) => [v.sku.toUpperCase(), v]));

  const skipBrandSet = new Set(skipBrandHeroIds);

  type JobInsert = {
    batch_id: string;
    hero_shot_id: string;
    swatch_id: string;
    status: 'pending';
    attempt: 0;
    prompt_adjustment?: string;
  };
  let jobs: JobInsert[] = [];
  let totalCombinations = 0;
  const skippedSwatches: { sku?: string; name: string; reason: string }[] = [];
  const resolverDecisions: Record<string, number> = {
    exact: 0,
    design_only: 0,
    size_only: 0,
    generic: 0,
  };

  if (useResolver) {
    for (const swatch of selectedSwatches) {
      const sku = (swatch.sku_suffix || '').toUpperCase();
      const variant = sku ? variantBySku.get(sku) : undefined;
      const design = variant?.color_slug || null;
      const size = sku ? extractSizeFromSku(sku) : null;
      const resolvedList = resolveHeroesForVariant(selectedHeroes, design, size);
      if (resolvedList.length === 0) {
        skippedSwatches.push({
          sku: swatch.sku_suffix,
          name: swatch.name,
          reason: 'no hero matches design+size tags',
        });
        continue;
      }
      // Multi-hero: 1 job por cada hero compatible con el swatch (todos los
      // tiers != none). Asi se mantiene la variedad de shot types.
      for (const resolved of resolvedList) {
        resolverDecisions[resolved.tier] = (resolverDecisions[resolved.tier] || 0) + 1;
        jobs.push({
          batch_id: '',
          hero_shot_id: resolved.hero.id,
          swatch_id: swatch.id,
          status: 'pending',
          attempt: 0,
          ...(skipBrandSet.has(resolved.hero.id) ? { prompt_adjustment: 'SKIP_BRAND' } : {}),
        });
      }
    }
    totalCombinations = jobs.length;
  } else {
    for (const hero of selectedHeroes) {
      for (const swatch of selectedSwatches) {
        jobs.push({
          batch_id: '',
          hero_shot_id: hero.id,
          swatch_id: swatch.id,
          status: 'pending',
          attempt: 0,
          ...(skipBrandSet.has(hero.id) ? { prompt_adjustment: 'SKIP_BRAND' } : {}),
        });
      }
    }
    totalCombinations = jobs.length;
  }

  if (totalCombinations === 0) {
    return NextResponse.json(
      {
        error: 'No jobs created',
        reason: 'resolver could not match any swatch to a hero',
        skipped: skippedSwatches,
      },
      { status: 400 }
    );
  }

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

  jobs = jobs.map((j) => ({ ...j, batch_id: batch.id }));

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

  return NextResponse.json(
    {
      ...batch,
      _resolver: useResolver
        ? { mode: 'resolver', decisions: resolverDecisions, skipped: skippedSwatches }
        : { mode: 'cross_product' },
    },
    { status: 201 }
  );
}

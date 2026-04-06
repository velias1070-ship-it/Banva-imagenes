import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import { COST_PER_IMAGE_USD } from '@/lib/constants';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

interface MlItem {
  id: string;
  pictures?: { id: string; secure_url: string }[];
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
 * Two modes:
 * - source:'heroes' (default) — use existing hero shots
 * - source:'ml' — download photos from ML listing for the selected variant
 *
 * Body: {
 *   target_swatch_id: string,        // required: variant to group results under
 *   source?: 'heroes' | 'ml',        // default 'heroes'
 *   hero_ids?: string[],             // filter (only for source:'heroes')
 *   brand_id?: string,               // optional override
 * }
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));

  const supabase = createAdminClient();
  const source: 'heroes' | 'ml' = body.source || 'heroes';

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

  // 2. Get target swatch
  const targetSwatchId: string | undefined = body.target_swatch_id;
  if (!targetSwatchId) {
    return NextResponse.json({ error: 'target_swatch_id is required' }, { status: 400 });
  }

  const { data: targetSwatch } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('id', targetSwatchId)
    .single();

  if (!targetSwatch) {
    return NextResponse.json({ error: 'Target swatch not found' }, { status: 400 });
  }

  // 3. Get heroes based on source
  let heroIds: string[] = [];

  if (source === 'ml') {
    // Download photos from ML listing for this variant's SKU
    if (!targetSwatch.sku_suffix) {
      return NextResponse.json({ error: 'Variant has no SKU linked. Cannot fetch from ML.' }, { status: 400 });
    }

    const inventoryDb = getInventorySupabase();
    const { data: mlItemData } = await inventoryDb
      .from('ml_items_map')
      .select('item_id')
      .eq('sku_venta', targetSwatch.sku_suffix)
      .eq('activo', true)
      .is('variation_id', null)
      .single();

    if (!mlItemData) {
      return NextResponse.json({ error: `SKU ${targetSwatch.sku_suffix} not found in ML` }, { status: 400 });
    }

    const item = await mlGet<MlItem>(`/items/${mlItemData.item_id}?attributes=pictures`);
    if (!item?.pictures?.length) {
      return NextResponse.json({ error: 'No pictures found on ML listing' }, { status: 400 });
    }

    // Get current max display_order
    const { data: existingHeroes } = await supabase
      .from('hero_shots')
      .select('display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: false })
      .limit(1);

    let nextOrder = (existingHeroes?.[0]?.display_order ?? -1) + 1;

    // Download each picture as hero (full quality -F)
    for (let i = 0; i < item.pictures.length; i++) {
      const pic = item.pictures[i];
      const imageUrl = pic.secure_url.replace(/-O\.(\w+)$/, '-F.$1');

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) continue;

      const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
      const heroUuid = crypto.randomUUID();
      const ext = imageUrl.includes('.webp') ? 'webp' : 'jpg';
      const storagePath = `projects/${projectId}/heroes/${heroUuid}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('images')
        .upload(storagePath, imageBuffer, {
          contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
          upsert: true,
        });

      if (uploadErr) continue;

      const shotType = i === 0 ? 'main' : 'lifestyle';
      const { data: hero } = await supabase
        .from('hero_shots')
        .insert({
          project_id: projectId,
          filename: `${targetSwatch.sku_suffix}_ml_${i + 1}.${ext}`,
          storage_path: storagePath,
          shot_type: shotType,
          display_order: nextOrder++,
          mime_type: ext === 'webp' ? 'image/webp' : 'image/jpeg',
        })
        .select('id')
        .single();

      if (hero) heroIds.push(hero.id);
    }

    if (heroIds.length === 0) {
      return NextResponse.json({ error: 'Failed to download any ML images' }, { status: 400 });
    }
  } else {
    // Use existing heroes
    const heroFilterIds: string[] | undefined = body.hero_ids;
    let heroQuery = supabase
      .from('hero_shots')
      .select('id')
      .eq('project_id', projectId);

    if (heroFilterIds?.length) {
      heroQuery = heroQuery.in('id', heroFilterIds);
    }

    const { data: heroes } = await heroQuery.order('display_order');
    if (!heroes?.length) {
      return NextResponse.json({ error: 'No hero shots found.' }, { status: 400 });
    }

    heroIds = heroes.map((h) => h.id);
  }

  // Ensure swatch has storage_path
  if (!targetSwatch.storage_path) {
    const { data: firstHero } = await supabase
      .from('hero_shots')
      .select('storage_path')
      .eq('id', heroIds[0])
      .single();

    if (firstHero?.storage_path) {
      await supabase.from('swatches').update({ storage_path: firstHero.storage_path }).eq('id', targetSwatch.id);
    }
  }

  // 4. Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'pending',
      total_combinations: heroIds.length,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: heroIds.length * COST_PER_IMAGE_USD,
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });
  }

  // 5. Create jobs with BRAND_ONLY flag
  const jobs = heroIds.map((heroId) => ({
    batch_id: batch.id,
    hero_shot_id: heroId,
    swatch_id: targetSwatch.id,
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
    total_jobs: heroIds.length,
    source,
    variant: targetSwatch.name,
  }, { status: 201 });
}

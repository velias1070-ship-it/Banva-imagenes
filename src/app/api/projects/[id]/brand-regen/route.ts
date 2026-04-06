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
  pictures?: { id: string; secure_url: string; size: string }[];
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
 * Regenerate ML listing images with brand applied:
 * 1. For each selected swatch, fetch ALL pictures from ML listing
 * 2. Save each picture as both hero AND swatch (same image)
 * 3. Create jobs with prompt_adjustment='BRAND_ONLY'
 * 4. Pipeline reproduces image identically but applies brand (colors, typography, logo)
 *
 * Body: { swatch_ids?: string[], brand_id?: string }
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));

  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

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

  // 2. Get swatches (optionally filtered)
  const swatchFilterIds: string[] | undefined = body.swatch_ids;
  let swatchQuery = supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId);

  if (swatchFilterIds?.length) {
    swatchQuery = swatchQuery.in('id', swatchFilterIds);
  }

  const { data: swatches } = await swatchQuery.order('display_order');
  const swatchesWithSku = (swatches || []).filter((s) => s.sku_suffix);

  if (!swatchesWithSku.length) {
    return NextResponse.json({ error: 'No swatches have SKU linked.' }, { status: 400 });
  }

  // 3. Look up ML items
  const allSkus = swatchesWithSku.map((s) => s.sku_suffix) as string[];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', allSkus)
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItem = new Map((mlItems || []).map((item) => [item.sku_venta, item]));

  // 4. Fetch ML images → save as hero + swatch, create job pairs
  const jobRows: { heroId: string; swatchId: string }[] = [];
  const errors: { sku: string; error: string }[] = [];

  const { data: existingHeroes } = await supabase
    .from('hero_shots')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  let nextHeroOrder = (existingHeroes?.[0]?.display_order ?? -1) + 1;

  const { data: existingSwatches } = await supabase
    .from('swatches')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  let nextSwatchOrder = (existingSwatches?.[0]?.display_order ?? -1) + 1;

  for (const swatch of swatchesWithSku) {
    const mlItem = skuToItem.get(swatch.sku_suffix!);
    if (!mlItem) {
      errors.push({ sku: swatch.sku_suffix!, error: 'SKU not found in ML' });
      continue;
    }

    try {
      const item = await mlGet<MlItem>(`/items/${mlItem.item_id}?attributes=pictures`);
      if (!item?.pictures?.length) {
        errors.push({ sku: swatch.sku_suffix!, error: 'No pictures on ML listing' });
        continue;
      }

      for (let picIdx = 0; picIdx < item.pictures.length; picIdx++) {
        const pic = item.pictures[picIdx];
        const imgRes = await fetch(pic.secure_url);
        if (!imgRes.ok) {
          errors.push({ sku: swatch.sku_suffix!, error: `Download failed pic ${picIdx + 1}: ${imgRes.status}` });
          continue;
        }

        const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = pic.secure_url.includes('.webp') ? 'webp' : 'jpg';
        const contentType = ext === 'webp' ? 'image/webp' : 'image/jpeg';

        // Save as hero
        const heroUuid = crypto.randomUUID();
        const heroPath = `projects/${projectId}/heroes/${heroUuid}.${ext}`;
        const { error: heroUploadErr } = await supabase.storage
          .from('images')
          .upload(heroPath, imageBuffer, { contentType, upsert: true });

        if (heroUploadErr) {
          errors.push({ sku: swatch.sku_suffix!, error: `Hero upload failed pic ${picIdx + 1}` });
          continue;
        }

        const shotType = picIdx === 0 ? 'main' : 'lifestyle';
        const { data: hero } = await supabase
          .from('hero_shots')
          .insert({
            project_id: projectId,
            filename: `${swatch.sku_suffix}_brand_${picIdx + 1}.${ext}`,
            storage_path: heroPath,
            shot_type: shotType,
            display_order: nextHeroOrder++,
            mime_type: contentType,
          })
          .select('id')
          .single();

        if (!hero) continue;

        // Save same image as a dedicated swatch for this job
        const swatchUuid = crypto.randomUUID();
        const swatchPath = `projects/${projectId}/swatches/${swatchUuid}.${ext}`;
        await supabase.storage
          .from('images')
          .upload(swatchPath, imageBuffer, { contentType, upsert: true });

        const { data: newSwatch } = await supabase
          .from('swatches')
          .insert({
            project_id: projectId,
            name: `${swatch.name} (brand-regen pic ${picIdx + 1})`,
            sku_suffix: swatch.sku_suffix,
            storage_path: swatchPath,
            color_description: swatch.name,
            display_order: nextSwatchOrder++,
          })
          .select('id')
          .single();

        if (!newSwatch) continue;

        jobRows.push({ heroId: hero.id, swatchId: newSwatch.id });
      }
    } catch (err) {
      errors.push({ sku: swatch.sku_suffix!, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (jobRows.length === 0) {
    return NextResponse.json({ error: 'Could not fetch any ML images', details: errors }, { status: 400 });
  }

  // 5. Create batch
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

  // 6. Create jobs with BRAND_ONLY flag
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

  // 7. Start processing
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
    ml_images_fetched: jobRows.length,
    variants_processed: swatchesWithSku.length,
    errors: errors.length > 0 ? errors : undefined,
  }, { status: 201 });
}

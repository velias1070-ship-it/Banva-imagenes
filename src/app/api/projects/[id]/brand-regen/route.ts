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
 * Automated flow to regenerate ML listing images with brand applied:
 * 1. Verify project has brand_id
 * 2. For each swatch with sku_suffix, fetch ML listing images
 * 3. Save first ML image as hero shot (per swatch)
 * 4. Create batch with 1:1 jobs (each hero paired with its swatch)
 * 5. Launch processing chain (brand is applied automatically)
 *
 * Body: { brand_id?: string } — optionally override project brand
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));

  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // 1. Get project
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, brand_id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Update brand if provided
  const brandId = body.brand_id || project.brand_id;
  if (!brandId) {
    return NextResponse.json({ error: 'No brand assigned. Set a brand in project settings first.' }, { status: 400 });
  }

  // Update project brand_id if different
  if (body.brand_id && body.brand_id !== project.brand_id) {
    await supabase.from('projects').update({ brand_id: body.brand_id }).eq('id', projectId);
  }

  // Verify brand exists
  const { data: brand } = await supabase.from('brands').select('id, name').eq('id', brandId).single();
  if (!brand) {
    return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
  }

  // 2. Get swatches with sku_suffix
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found in project' }, { status: 400 });
  }

  const swatchesWithSku = swatches.filter((s) => s.sku_suffix);
  if (!swatchesWithSku.length) {
    return NextResponse.json({ error: 'No swatches have SKU linked. Create project from catalog first.' }, { status: 400 });
  }

  // 3. Look up ML items for all SKUs
  const allSkus = swatchesWithSku.map((s) => s.sku_suffix) as string[];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', allSkus)
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItem = new Map((mlItems || []).map((item) => [item.sku_venta, item]));

  // 4. Fetch ML images and create heroes
  const heroSwatchPairs: { heroId: string; swatchId: string }[] = [];
  const errors: { sku: string; error: string }[] = [];

  // Get current max display_order for heroes
  const { data: existingHeroes } = await supabase
    .from('hero_shots')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  let nextOrder = (existingHeroes?.[0]?.display_order ?? -1) + 1;

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

      // Download ALL pictures from the listing as heroes
      for (let picIdx = 0; picIdx < item.pictures.length; picIdx++) {
        const pic = item.pictures[picIdx];
        const imgRes = await fetch(pic.secure_url);
        if (!imgRes.ok) {
          errors.push({ sku: swatch.sku_suffix!, error: `Download failed pic ${picIdx + 1}: ${imgRes.status}` });
          continue;
        }

        const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        const heroId = crypto.randomUUID();
        const ext = pic.secure_url.includes('.webp') ? 'webp' : 'jpg';
        const storagePath = `projects/${projectId}/heroes/${heroId}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(storagePath, imageBuffer, {
            contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
            upsert: true,
          });

        if (uploadError) {
          errors.push({ sku: swatch.sku_suffix!, error: `Upload failed pic ${picIdx + 1}: ${uploadError.message}` });
          continue;
        }

        // Infer shot type from position: first = main, rest = lifestyle
        const shotType = picIdx === 0 ? 'main' : 'lifestyle';

        const { data: hero, error: heroError } = await supabase
          .from('hero_shots')
          .insert({
            project_id: projectId,
            filename: `${swatch.sku_suffix}_ml_${picIdx + 1}.${ext}`,
            storage_path: storagePath,
            shot_type: shotType,
            display_order: nextOrder++,
            mime_type: ext === 'webp' ? 'image/webp' : 'image/jpeg',
          })
          .select('id')
          .single();

        if (heroError || !hero) {
          errors.push({ sku: swatch.sku_suffix!, error: `Hero insert failed pic ${picIdx + 1}: ${heroError?.message}` });
          continue;
        }

        heroSwatchPairs.push({ heroId: hero.id, swatchId: swatch.id });
      }
    } catch (err) {
      errors.push({ sku: swatch.sku_suffix!, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (heroSwatchPairs.length === 0) {
    return NextResponse.json({
      error: 'Could not fetch any ML images',
      details: errors,
    }, { status: 400 });
  }

  // 5. Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'pending',
      total_combinations: heroSwatchPairs.length,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: heroSwatchPairs.length * COST_PER_IMAGE_USD,
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });
  }

  // 6. Create jobs (1:1 hero-swatch pairs, NOT cartesian product)
  const jobs = heroSwatchPairs.map((pair) => ({
    batch_id: batch.id,
    hero_shot_id: pair.heroId,
    swatch_id: pair.swatchId,
    status: 'pending' as const,
    attempt: 0,
  }));

  const { error: jobsError } = await supabase.from('generation_jobs').insert(jobs);
  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  // 7. Start processing chain
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
    total_jobs: heroSwatchPairs.length,
    ml_images_fetched: heroSwatchPairs.length,
    errors: errors.length > 0 ? errors : undefined,
  }, { status: 201 });
}

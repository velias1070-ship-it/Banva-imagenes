import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

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

/**
 * POST /api/projects/{id}/fetch-ml-images
 *
 * For each swatch with sku_suffix:
 * 1. Look up item_id in ml_items_map
 * 2. GET /items/{item_id} from ML
 * 3. Download picture[0] (position 1)
 * 4. Upload to Supabase Storage as the swatch image
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true; // Re-download even if swatch already has image
  const syncNew = body.sync_new !== false; // Also check for new variants in ML (default true)

  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // 1. Get swatches for this project
  const { data: swatches, error: swError } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  if (swError || !swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 404 });
  }

  // 2. Get ML item mappings for all SKUs
  const skus = swatches
    .map((s) => s.sku_suffix)
    .filter(Boolean) as string[];

  // Also get the project to find its catalog variantes
  const { data: project } = await supabase
    .from('projects')
    .select('metadata')
    .eq('id', projectId)
    .single();

  // Check if there are new variantes in metadata that don't have swatches yet
  if (syncNew && project?.metadata) {
    const catalogVariantes = (project.metadata as { variantes?: { sku: string; color: string }[] }).variantes || [];
    const existingSkus = new Set(swatches.map((s) => s.sku_suffix).filter(Boolean));

    const newVariantes = catalogVariantes.filter((v) => !existingSkus.has(v.sku));
    if (newVariantes.length > 0) {
      const newRows = newVariantes.map((v, i) => ({
        project_id: projectId,
        name: v.color,
        sku_suffix: v.sku,
        color_description: v.color,
        display_order: swatches.length + i,
      }));

      await supabase.from('swatches').insert(newRows);

      // Re-fetch swatches to include new ones
      const { data: updatedSwatches } = await supabase
        .from('swatches')
        .select('id, name, sku_suffix, storage_path')
        .eq('project_id', projectId)
        .order('display_order');

      if (updatedSwatches) {
        swatches.length = 0;
        swatches.push(...updatedSwatches);
      }
    }
  }

  // Recalculate SKUs after potential sync
  const allSkus = swatches
    .map((s) => s.sku_suffix)
    .filter(Boolean) as string[];

  if (!allSkus.length) {
    return NextResponse.json({ error: 'No swatches have sku_suffix. Create project from catalog first.' }, { status: 400 });
  }

  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .in('sku_venta', allSkus)
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItem = new Map((mlItems || []).map((item) => [item.sku_venta, item]));

  // 3. Process each swatch
  const results: {
    swatch: string;
    sku: string;
    item_id: string;
    status: 'success' | 'skipped' | 'error';
    error?: string;
  }[] = [];

  for (const swatch of swatches) {
    if (!swatch.sku_suffix) {
      results.push({ swatch: swatch.name, sku: '', item_id: '', status: 'skipped', error: 'No sku_suffix' });
      continue;
    }

    // Skip if swatch already has an image (unless force refresh)
    if (swatch.storage_path && !forceRefresh) {
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: '', status: 'skipped', error: 'Already has image' });
      continue;
    }

    const mlItem = skuToItem.get(swatch.sku_suffix);
    if (!mlItem) {
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: '', status: 'skipped', error: 'SKU not in ml_items_map' });
      continue;
    }

    try {
      // Fetch item from ML to get pictures
      const item = await mlGet<MlItem>(`/items/${mlItem.item_id}?attributes=pictures`);

      if (!item.pictures?.length) {
        results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: mlItem.item_id, status: 'skipped', error: 'No pictures on ML listing' });
        continue;
      }

      // Get position 1 (first picture)
      const pic = item.pictures[0];
      const imageUrl = pic.secure_url;

      // Download the image
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: mlItem.item_id, status: 'error', error: `Failed to download: ${imgRes.status}` });
        continue;
      }

      const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
      const ext = imageUrl.includes('.webp') ? 'webp' : 'jpg';
      const storagePath = `projects/${projectId}/swatches/${swatch.id}.${ext}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('images')
        .upload(storagePath, imageBuffer, {
          contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
          upsert: true,
        });

      if (uploadError) {
        results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: mlItem.item_id, status: 'error', error: uploadError.message });
        continue;
      }

      // Update swatch record with storage path
      await supabase
        .from('swatches')
        .update({ storage_path: storagePath })
        .eq('id', swatch.id);

      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: mlItem.item_id, status: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, item_id: mlItem.item_id, status: 'error', error: message });
    }
  }

  return NextResponse.json({
    project_id: projectId,
    total: results.length,
    success: results.filter((r) => r.status === 'success').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    details: results,
  });
}

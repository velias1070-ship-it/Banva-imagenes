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

  // 1. Get project metadata first (needed to bootstrap swatches if empty)
  const { data: project } = await supabase
    .from('projects')
    .select('name, metadata')
    .eq('id', projectId)
    .single();

  // 2. Get existing swatches
  let { data: swatches } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  if (!swatches) swatches = [];

  // 3. If no swatches exist, bootstrap from project metadata or return detailed error
  if (swatches.length === 0) {
    const meta = project?.metadata as Record<string, unknown> | null;
    const catalogVariantes = (meta?.variantes as { sku: string; color: string }[] | undefined) || [];

    console.log(`[fetch-ml-images] No swatches for ${projectId}. metadata variantes: ${catalogVariantes.length}`);

    if (catalogVariantes.length > 0) {
      const newRows = catalogVariantes.map((v, i) => ({
        project_id: projectId,
        name: v.color,
        sku_suffix: v.sku,
        color_description: v.color,
        display_order: i,
      }));

      const { error: insertErr } = await supabase.from('swatches').insert(newRows);
      if (insertErr) {
        console.error('[fetch-ml-images] swatch insert error:', insertErr);
        return NextResponse.json({
          error: `Failed to create swatches: ${insertErr.message}`,
          detail: insertErr,
        }, { status: 500 });
      }

      const { data: created } = await supabase
        .from('swatches')
        .select('id, name, sku_suffix, storage_path')
        .eq('project_id', projectId)
        .order('display_order');

      swatches = created || [];
    }
  }

  if (!swatches.length) {
    return NextResponse.json({
      error: 'No swatches found and could not create from metadata',
      project_has_metadata: !!project?.metadata,
      metadata_keys: project?.metadata ? Object.keys(project.metadata as Record<string, unknown>) : [],
    }, { status: 404 });
  }

  if (syncNew) {
    const existingSkus = new Set(swatches.map((s) => s.sku_suffix).filter(Boolean));
    let newRows: { project_id: string; name: string; sku_suffix: string; color_description: string; display_order: number }[] = [];

    // Source 1: catalog variantes from project metadata
    if (project?.metadata) {
      const catalogVariantes = (project.metadata as { variantes?: { sku: string; color: string }[] }).variantes || [];
      const newFromCatalog = catalogVariantes.filter((v) => !existingSkus.has(v.sku));
      for (const v of newFromCatalog) {
        existingSkus.add(v.sku);
        newRows.push({
          project_id: projectId,
          name: v.color,
          sku_suffix: v.sku,
          color_description: v.color,
          display_order: swatches.length + newRows.length,
        });
      }
    }

    // Source 2: discover new SKUs from ml_items_map that share the SKU prefix
    // e.g. if existing SKUs are TXV23QLAT25BE, TXV23QLAT25BC → prefix = TXV23QLAT25
    // This ensures we only find variants of the SAME size, not 15P/20P/30P mixed in
    const currentSkus = Array.from(existingSkus);
    if (currentSkus.length > 0) {
      let skuPrefix = currentSkus[0];
      for (let i = 1; i < currentSkus.length; i++) {
        while (!currentSkus[i].startsWith(skuPrefix)) {
          skuPrefix = skuPrefix.slice(0, -1);
          if (skuPrefix.length === 0) break;
        }
      }

      if (skuPrefix.length >= 6) {
        const { data: mlMatches } = await inventoryDb
          .from('ml_items_map')
          .select('sku_venta, item_id, titulo')
          .like('sku_venta', `${skuPrefix}%`)
          .eq('activo', true)
          .is('variation_id', null)
          .limit(50);

        if (mlMatches) {
          for (const ml of mlMatches) {
            if (existingSkus.has(ml.sku_venta)) continue;

            const titleWords = ml.titulo.split(/\s+/);
            let colorGuess = ml.sku_venta;
            for (let i = titleWords.length - 1; i >= 0; i--) {
              const w = titleWords[i];
              if (w && !/^\d/.test(w) && w.length > 1 && !['Cm', 'M', 'Plazas', 'Plaza', 'King', 'Super'].includes(w)) {
                colorGuess = w;
                break;
              }
            }

            existingSkus.add(ml.sku_venta);
            newRows.push({
              project_id: projectId,
              name: colorGuess,
              sku_suffix: ml.sku_venta,
              color_description: colorGuess,
              display_order: swatches.length + newRows.length,
            });
          }
        }
      }
    }

    // Insert new swatches
    if (newRows.length > 0) {
      await supabase.from('swatches').insert(newRows);

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

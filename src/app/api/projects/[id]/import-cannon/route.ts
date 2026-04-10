import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import { ensureOutputSpec } from '@/lib/image-processing';

export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function buildCannonImagePatterns(attrs: Record<string, string>): string[] {
  const design = attrs.FABRIC_DESIGN;
  const model = attrs.MODEL || '';
  const size = attrs.MATTRESS_SIZE;
  const color = attrs.COLOR || attrs.MAIN_COLOR || '';
  const fabric = attrs.FABRIC_COMPOSITION || attrs.FABRIC || '';
  if (!design) return [];

  const designCompact = slugify(design.replace(/\s*\d+$/, ''));
  const sizeCompact = slugify(size || '2 plazas');
  const colorCompact = slugify(color);
  const threadMatch = model.match(/(\d+)\s*hilos/i);
  const threadCount = threadMatch ? threadMatch[1] : null;

  const isPolar = /polar|fleece/i.test(model + ' ' + fabric + ' ' + design);

  const patterns: string[] = [];
  if (isPolar) {
    // With color: sabanaspolar1plazalisomalva (Liso Malva)
    if (colorCompact) {
      patterns.push(`sabanaspolar${sizeCompact}${designCompact}${colorCompact}`);
    }
    // Without color: sabanaspolar1plazaaba (Aba — design IS the variant)
    patterns.push(`sabanaspolar${sizeCompact}${designCompact}`);
  }
  if (threadCount) {
    patterns.push(`sabanas${sizeCompact}${threadCount}hilos${designCompact}`);
  }
  if (!patterns.length) {
    patterns.push(`sabanas${sizeCompact}144hilos${designCompact}`);
    patterns.push(`sabanaspolar${sizeCompact}${designCompact}`);
    if (colorCompact) patterns.push(`sabanaspolar${sizeCompact}${designCompact}${colorCompact}`);
  }
  return patterns;
}

function cannonUrl(pattern: string, index: number): string {
  return `https://cannonhome.cl/media/catalog/product/s/a/${pattern}_${index}.jpg`;
}

/**
 * POST /api/projects/{id}/import-cannon
 * Body: { swatch_ids?: string[] } — optional filter, defaults to all swatches
 *
 * For each swatch:
 * 1. Gets ML item attributes (BRAND, FABRIC_DESIGN, etc.)
 * 2. Builds Cannon image URLs
 * 3. Downloads all available images
 * 4. Creates approved generation_jobs for each image
 *
 * Result: images appear in project results, ready to publish to ML.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();
  const body = await request.json().catch(() => ({}));
  const filterSwatchIds: string[] | undefined = body.swatch_ids;
  const force: boolean = body.force === true;

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get swatches
  let swatchQuery = supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  const { data: swatches } = await swatchQuery;
  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 400 });
  }

  const targetSwatches = filterSwatchIds?.length
    ? swatches.filter((s) => filterSwatchIds.includes(s.id))
    : swatches;

  // Get or create a batch for imports
  let batchId: string;
  const { data: existingBatch } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingBatch?.length) {
    batchId = existingBatch[0].id;
  } else {
    const { data: newBatch } = await supabase
      .from('generation_batches')
      .insert({
        project_id: projectId,
        status: 'completed',
        total_combinations: 0,
        completed_count: 0,
        approved_count: 0,
        retry_count: 0,
        flagged_count: 0,
        error_count: 0,
      })
      .select()
      .single();
    batchId = newBatch!.id;
  }

  // We need a hero_shot to associate jobs with — create a placeholder if none exists
  let heroShotId: string;
  const { data: existingHero } = await supabase
    .from('hero_shots')
    .select('id')
    .eq('project_id', projectId)
    .limit(1);

  if (existingHero?.length) {
    heroShotId = existingHero[0].id;
  } else {
    const { data: newHero } = await supabase
      .from('hero_shots')
      .insert({
        project_id: projectId,
        filename: 'cannon-import',
        shot_type: 'main',
        storage_path: '',
        display_order: 0,
      })
      .select()
      .single();
    heroShotId = newHero!.id;
  }

  const results: {
    swatch: string;
    sku: string;
    images_imported: number;
    errors: string[];
    debug?: { attrs?: Record<string, string>; patterns?: string[]; working?: string | null };
  }[] = [];

  // Get all existing cannon imports for this project to avoid duplicates
  const batchIds = [batchId];
  const { data: allBatches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);
  if (allBatches) {
    for (const b of allBatches) {
      if (!batchIds.includes(b.id)) batchIds.push(b.id);
    }
  }

  const { data: existingJobs } = await supabase
    .from('generation_jobs')
    .select('swatch_id, prompt_metadata')
    .in('batch_id', batchIds)
    .eq('status', 'approved');

  const swatchesWithCannonImport = new Set<string>();
  for (const job of existingJobs || []) {
    const meta = job.prompt_metadata as Record<string, unknown> | null;
    if (meta?.strategy === 'cannon_import') {
      swatchesWithCannonImport.add(job.swatch_id);
    }
  }

  for (const swatch of targetSwatches) {
    if (!swatch.sku_suffix) {
      results.push({ swatch: swatch.name, sku: '', images_imported: 0, errors: ['No SKU'] });
      continue;
    }

    // Skip if already imported from Cannon (unless force=true)
    if (!force && swatchesWithCannonImport.has(swatch.id)) {
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: ['Ya importado de Cannon'] });
      continue;
    }

    // Force mode: delete previous Cannon imports for this swatch
    if (force && swatchesWithCannonImport.has(swatch.id)) {
      const { data: oldJobs } = await supabase
        .from('generation_jobs')
        .select('id, output_storage_path, prompt_metadata')
        .in('batch_id', batchIds)
        .eq('swatch_id', swatch.id)
        .eq('status', 'approved');
      for (const oldJob of oldJobs || []) {
        const meta = oldJob.prompt_metadata as Record<string, unknown> | null;
        if (meta?.strategy === 'cannon_import') {
          if (oldJob.output_storage_path) {
            await supabase.storage.from('images').remove([oldJob.output_storage_path]);
          }
          await supabase.from('generation_jobs').delete().eq('id', oldJob.id);
        }
      }
    }

    const swatchResult: typeof results[number] = { swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: [] as string[], debug: {} };

    try {
      // Find item_id
      const { data: mlItem } = await inventoryDb
        .from('ml_items_map')
        .select('item_id')
        .eq('sku_venta', swatch.sku_suffix)
        .eq('activo', true)
        .is('variation_id', null)
        .maybeSingle();

      let itemId = mlItem?.item_id;
      if (!itemId) {
        const search = await mlGet<{ results: string[] }>(
          `/users/1953806321/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
        );
        if (search?.results?.[0]) itemId = search.results[0];
      }

      if (!itemId) {
        swatchResult.errors.push('SKU not found in ML');
        results.push(swatchResult);
        continue;
      }

      // Get attributes
      const item = await mlGet<{
        attributes: Array<{ id: string; value_name: string | null }>;
      }>(`/items/${itemId}?attributes=attributes`);

      if (!item?.attributes) {
        swatchResult.errors.push('Could not fetch attributes');
        results.push(swatchResult);
        continue;
      }

      const attrs: Record<string, string> = {};
      for (const attr of item.attributes) {
        if (attr.value_name) attrs[attr.id] = attr.value_name;
      }
      swatchResult.debug!.attrs = attrs;

      const brand = (attrs.BRAND || '').toLowerCase();
      if (!brand.includes('cannon') && !brand.includes('american family')) {
        swatchResult.errors.push(`Not Cannon (brand: ${attrs.BRAND || 'unknown'})`);
        results.push(swatchResult);
        continue;
      }

      // Build Cannon URL patterns and try each one
      const patterns = buildCannonImagePatterns(attrs);
      swatchResult.debug!.patterns = patterns;

      let workingPattern: string | null = null;
      // Find first pattern where _1 exists
      for (const p of patterns) {
        try {
          const res = await fetch(cannonUrl(p, 1), { headers: { 'Accept': 'image/*' }, method: 'HEAD' });
          if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
            workingPattern = p;
            break;
          }
        } catch { /* try next */ }
      }

      swatchResult.debug!.working = workingPattern;
      if (!workingPattern) {
        swatchResult.errors.push(`No images found at Cannon (tried: ${patterns.join(', ')})`);
        results.push(swatchResult);
        continue;
      }

      // Download all available images for the working pattern
      for (let idx = 1; idx <= 10; idx++) {
        const url = cannonUrl(workingPattern, idx);
        try {
          const res = await fetch(url, { headers: { 'Accept': 'image/*' } });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok || !contentType.startsWith('image/')) break;

          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 5000) break;

          // Post-process to 1200x1200
          const processed = await ensureOutputSpec(buffer, 1200);

          // Upload
          const jobId = crypto.randomUUID();
          const storagePath = `projects/${projectId}/generated/${jobId}.png`;
          await supabase.storage.from('images').upload(storagePath, processed, {
            contentType: 'image/png',
            upsert: true,
          });

          // Create approved job
          await supabase.from('generation_jobs').insert({
            id: jobId,
            batch_id: batchId,
            hero_shot_id: heroShotId,
            swatch_id: swatch.id,
            status: 'approved',
            attempt: 0,
            output_storage_path: storagePath,
            qa_score: 1.0,
            prompt_metadata: {
              strategy: 'cannon_import',
              source_url: url,
              design: attrs.FABRIC_DESIGN,
            },
          });

          swatchResult.images_imported++;
        } catch {
          break; // Stop trying more images for this swatch
        }
      }
    } catch (err) {
      swatchResult.errors.push(err instanceof Error ? err.message : String(err));
    }

    results.push(swatchResult);
  }

  // Update batch counts
  const totalImported = results.reduce((sum, r) => sum + r.images_imported, 0);
  await supabase
    .from('generation_batches')
    .update({
      approved_count: totalImported,
      completed_count: totalImported,
      total_combinations: totalImported,
    })
    .eq('id', batchId);

  return NextResponse.json({
    total_swatches: results.length,
    total_images: totalImported,
    success: results.filter((r) => r.images_imported > 0).length,
    skipped: results.filter((r) => r.images_imported === 0 && r.errors.length === 0).length,
    errors: results.filter((r) => r.errors.length > 0).length,
    details: results,
  });
}

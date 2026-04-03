import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MissingVariant {
  item_id: string;
  title: string;
  seller_sku: string;
  status: string;
  available_quantity: number;
}

/**
 * GET /api/projects/{id}/missing-variants
 *
 * Finds ML listings that belong to this project but don't have a swatch.
 * Uses the project name to search ML by title, then compares against
 * existing swatches.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('name, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get existing swatch SKUs
  const { data: swatches } = await supabase
    .from('swatches')
    .select('sku_suffix')
    .eq('project_id', projectId);

  const existingSkus = new Set(
    (swatches || []).map((s) => s.sku_suffix).filter(Boolean)
  );

  // Build search query from project name
  // "Jgo Sabanas AF 144H 50%Alg Est 2.0 W23" → "sabanas 144 hilos AF"
  const name = project.name.toLowerCase();
  const searchTerms: string[] = [];

  // Extract key terms for ML search
  if (name.includes('sabana')) searchTerms.push('sabanas');
  else if (name.includes('quilt')) searchTerms.push('quilt');
  else if (name.includes('toalla')) searchTerms.push('toallas');
  else if (name.includes('cubrecama')) searchTerms.push('cubrecamas');
  else if (name.includes('plumon')) searchTerms.push('plumon');
  else if (name.includes('frazada')) searchTerms.push('frazada');
  else searchTerms.push(project.name.split(/\s+/).slice(0, 3).join(' '));

  // Extract thread count
  const hilosMatch = name.match(/(\d+)\s*h/);
  if (hilosMatch) searchTerms.push(`${hilosMatch[1]} hilos`);

  // Extract brand/line
  if (name.includes(' af ') || name.includes('american')) searchTerms.push('AF');
  if (name.includes(' cn ') || name.includes('cannon')) searchTerms.push('cannon');

  const searchQuery = searchTerms.join(' ');

  // Search ML for all matching items
  const sellerId = '1953806321';
  const allItems: MissingVariant[] = [];
  let offset = 0;

  while (offset < 200) {
    const result = await mlGet<{
      results: string[];
      paging: { total: number };
    }>(`/users/${sellerId}/items/search?q=${encodeURIComponent(searchQuery)}&limit=50&offset=${offset}`);

    if (!result?.results?.length) break;

    // Get details for each item
    const ids = result.results.join(',');
    const items = await mlGet<Array<{
      code: number;
      body: {
        id: string;
        title: string;
        status: string;
        available_quantity: number;
        seller_custom_field: string | null;
        attributes?: Array<{ id: string; value_name: string | null }>;
      };
    }>>(`/items?ids=${ids}&attributes=id,title,status,available_quantity,seller_custom_field,attributes`);

    if (items) {
      for (const item of items) {
        if (!item.body) continue;
        // Extract seller_sku from attributes
        const skuAttr = item.body.attributes?.find((a) => a.id === 'SELLER_SKU');
        const sellerSku = skuAttr?.value_name || item.body.seller_custom_field || '';

        // Skip if already in project
        if (existingSkus.has(sellerSku)) continue;
        // Skip if no SKU
        if (!sellerSku) continue;

        allItems.push({
          item_id: item.body.id,
          title: item.body.title,
          seller_sku: sellerSku,
          status: item.body.status,
          available_quantity: item.body.available_quantity,
        });
      }
    }

    offset += 50;
    if (offset >= result.paging.total) break;
  }

  return NextResponse.json({
    search_query: searchQuery,
    existing_swatches: existingSkus.size,
    missing: allItems,
    missing_count: allItems.length,
  });
}

/**
 * POST /api/projects/{id}/missing-variants
 * Body: { skus: ["TXSBAF144DL20", ...] }
 *
 * Adds the selected missing variants as swatches.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const body = await request.json();
  const skus: string[] = body.skus || [];

  if (!skus.length) {
    return NextResponse.json({ error: 'No SKUs provided' }, { status: 400 });
  }

  // Get current max display_order
  const { data: lastSwatch } = await supabase
    .from('swatches')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  let nextOrder = (lastSwatch?.[0]?.display_order ?? -1) + 1;
  let added = 0;

  for (const sku of skus) {
    // Get item info from ML
    const sellerId = '1953806321';
    const search = await mlGet<{ results: string[] }>(
      `/users/${sellerId}/items/search?seller_sku=${sku}&limit=1`
    );

    if (!search?.results?.[0]) continue;

    const itemId = search.results[0];
    const item = await mlGet<{ id: string; title: string; pictures?: Array<{ secure_url: string }> }>(
      `/items/${itemId}?attributes=id,title,pictures`
    );

    if (!item) continue;

    // Extract color from title (last meaningful word)
    const words = (item.title || '').split(/\s+/);
    let colorName = sku;
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (w && !/^\d/.test(w) && w.length > 1 && !['Cm', 'M', 'Plazas', 'Plaza', 'King', 'Super', 'De', 'Y', 'En', 'La', 'El', 'Af', 'Hilos'].includes(w)) {
        colorName = w;
        break;
      }
    }

    // Download first image if available
    let storagePath = '';
    let fileSizeKb = 0;
    if (item.pictures?.length) {
      try {
        const imgRes = await fetch(item.pictures[0].secure_url);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const ext = item.pictures[0].secure_url.includes('.webp') ? 'webp' : 'jpg';
          storagePath = `projects/${projectId}/swatches/${crypto.randomUUID()}.${ext}`;
          fileSizeKb = Math.round(buf.length / 1024);
          await supabase.storage.from('images').upload(storagePath, buf, {
            contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
            upsert: true,
          });
        }
      } catch { /* skip image */ }
    }

    // Insert swatch
    await supabase.from('swatches').insert({
      project_id: projectId,
      name: colorName,
      sku_suffix: sku,
      color_description: colorName,
      storage_path: storagePath,
      display_order: nextOrder++,
      file_size_kb: fileSizeKb,
    });

    added++;
  }

  return NextResponse.json({ added, total_requested: skus.length });
}

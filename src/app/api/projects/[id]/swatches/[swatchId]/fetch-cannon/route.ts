import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

/**
 * Build a cannonhome.cl product URL from ML item attributes.
 *
 * Pattern: cannonhome.cl/sabanas-{size}-{threadcount}-hilos-{design}.html
 * Image:   cannonhome.cl/media/catalog/product/s/a/sabanas{size}{threadcount}hilos{design}_1.jpg
 */
function buildCannonUrl(attrs: Record<string, string>): { pageUrl: string; imageUrl: string } | null {
  const design = attrs.FABRIC_DESIGN;
  const model = attrs.MODEL;
  const size = attrs.MATTRESS_SIZE;

  if (!design) return null;

  // Normalize design name: "Flora 2" → "flora", "Oasis Verde" → "oasis-verde"
  const designSlug = design
    .toLowerCase()
    .replace(/\s*\d+$/, '') // remove trailing numbers like "Flora 2" → "Flora"
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  // Normalize size: "2 plazas" → "2-plazas"
  const sizeSlug = (size || '2 plazas')
    .toLowerCase()
    .replace(/\s+/g, '-');

  // Extract thread count: "144 hilos" → "144"
  const threadMatch = (model || '').match(/(\d+)\s*hilos/i);
  const threadCount = threadMatch ? threadMatch[1] : '144';

  // Build URL parts
  const sizeCompact = sizeSlug.replace(/-/g, '');  // "2plazas"
  const designCompact = designSlug.replace(/-/g, '');  // "cuadramini" (image URLs have no dashes)
  const pageUrl = `https://cannonhome.cl/sabanas-${sizeSlug}-${threadCount}-hilos-${designSlug}.html`;
  const imageUrl = `https://cannonhome.cl/media/catalog/product/s/a/sabanas${sizeCompact}${threadCount}hilos${designCompact}_1.jpg`;

  return { pageUrl, imageUrl };
}

/**
 * POST — Fetch swatch image from cannonhome.cl using ML item attributes.
 *
 * 1. Gets the swatch's SKU → finds item_id in ml_items_map
 * 2. Fetches ML item attributes (BRAND, FABRIC_DESIGN, MODEL, MATTRESS_SIZE)
 * 3. If brand is Cannon, builds cannonhome.cl URL
 * 4. Downloads image and updates swatch
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // Get swatch
  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('id', swatchId)
    .single();

  if (!swatch?.sku_suffix) {
    return NextResponse.json({ error: 'Swatch has no SKU' }, { status: 400 });
  }

  // Find item_id
  const { data: mlItem } = await inventoryDb
    .from('ml_items_map')
    .select('item_id')
    .eq('sku_venta', swatch.sku_suffix)
    .eq('activo', true)
    .is('variation_id', null)
    .maybeSingle();

  let itemId = mlItem?.item_id;

  // If not in ml_items_map, search ML directly
  if (!itemId) {
    const searchResult = await mlGet<{ results: string[] }>(
      `/users/1953806321/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
    );
    if (searchResult?.results?.[0]) {
      itemId = searchResult.results[0];
    }
  }

  if (!itemId) {
    return NextResponse.json({ error: `SKU ${swatch.sku_suffix} not found in ML` }, { status: 404 });
  }

  // Fetch item attributes from ML
  const item = await mlGet<{
    id: string;
    title: string;
    attributes: Array<{ id: string; value_name: string | null }>;
  }>(`/items/${itemId}?attributes=id,title,attributes`);

  if (!item?.attributes) {
    return NextResponse.json({ error: 'Could not fetch item attributes' }, { status: 502 });
  }

  // Build attributes map
  const attrs: Record<string, string> = {};
  for (const attr of item.attributes) {
    if (attr.value_name) {
      attrs[attr.id] = attr.value_name;
    }
  }

  const brand = (attrs.BRAND || '').toLowerCase();
  if (!brand.includes('cannon') && !brand.includes('american family')) {
    return NextResponse.json({
      error: `Brand is "${attrs.BRAND || 'unknown'}", not Cannon. This feature only works for Cannon products.`,
      brand: attrs.BRAND,
      design: attrs.FABRIC_DESIGN,
    }, { status: 400 });
  }

  // Build Cannon URL
  const cannonUrls = buildCannonUrl(attrs);
  if (!cannonUrls) {
    return NextResponse.json({
      error: 'Could not build Cannon URL — missing FABRIC_DESIGN attribute',
      attrs: { FABRIC_DESIGN: attrs.FABRIC_DESIGN, MODEL: attrs.MODEL, MATTRESS_SIZE: attrs.MATTRESS_SIZE },
    }, { status: 400 });
  }

  // Try to download the image directly
  let imageBuffer: Buffer | null = null;
  let sourceUrl = cannonUrls.imageUrl;

  console.log(`[fetch-cannon] Trying image URL: ${cannonUrls.imageUrl}`);

  const directRes = await fetch(cannonUrls.imageUrl, {
    headers: { 'Accept': 'image/*' },
    redirect: 'follow',
  });
  const directContentType = directRes.headers.get('content-type') || '';
  if (directRes.ok && directContentType.startsWith('image/')) {
    imageBuffer = Buffer.from(await directRes.arrayBuffer());
    console.log(`[fetch-cannon] Direct download: ${imageBuffer.length} bytes, type: ${directContentType}`);
  } else {
    console.log(`[fetch-cannon] Direct failed: status=${directRes.status}, type=${directContentType}`);
  }

  // If direct failed, try with optimize params
  if (!imageBuffer || imageBuffer.length < 5000) {
    const optimizedUrl = `${cannonUrls.imageUrl}?optimize=medium&bg-color=255,255,255&fit=bounds&height=1200&width=1200`;
    console.log(`[fetch-cannon] Trying optimized URL: ${optimizedUrl}`);
    const optRes = await fetch(optimizedUrl, {
      headers: { 'Accept': 'image/*' },
      redirect: 'follow',
    });
    const optContentType = optRes.headers.get('content-type') || '';
    if (optRes.ok && optContentType.startsWith('image/')) {
      imageBuffer = Buffer.from(await optRes.arrayBuffer());
      sourceUrl = optimizedUrl;
      console.log(`[fetch-cannon] Optimized download: ${imageBuffer.length} bytes`);
    }
  }

  // Fallback: try the page URL and scrape the main image
  if (!imageBuffer || imageBuffer.length < 5000) {
    console.log(`[fetch-cannon] Image download failed, trying page scrape: ${cannonUrls.pageUrl}`);
    try {
      const pageRes = await fetch(cannonUrls.pageUrl);
      if (pageRes.ok) {
        const html = await pageRes.text();
        // Look for product image in the HTML
        const imgMatch = html.match(/media\/catalog\/product[^"']+\.(jpg|jpeg|png|webp)/i);
        if (imgMatch) {
          const scraped = `https://cannonhome.cl/${imgMatch[0]}`;
          console.log(`[fetch-cannon] Found image in page: ${scraped}`);
          const scrapedRes = await fetch(scraped, { headers: { 'Accept': 'image/*' } });
          const scrapedType = scrapedRes.headers.get('content-type') || '';
          if (scrapedRes.ok && scrapedType.startsWith('image/')) {
            imageBuffer = Buffer.from(await scrapedRes.arrayBuffer());
            sourceUrl = scraped;
          }
        }
      }
    } catch (err) {
      console.error(`[fetch-cannon] Page scrape failed:`, err);
    }
  }

  if (!imageBuffer || imageBuffer.length < 1000) {
    return NextResponse.json({
      error: 'Image not found on cannonhome.cl',
      tried_url: cannonUrls.imageUrl,
      page_url: cannonUrls.pageUrl,
      design: attrs.FABRIC_DESIGN,
    }, { status: 404 });
  }

  // Upload to Supabase Storage
  const ext = sourceUrl.includes('.png') ? 'png' : 'jpg';
  const storageName = `${crypto.randomUUID()}.${ext}`;
  const storagePath = `projects/${projectId}/swatches/${storageName}`;

  // Delete old image if exists
  if (swatch.storage_path) {
    await supabase.storage.from('images').remove([swatch.storage_path]);
  }

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, imageBuffer, {
      contentType: `image/${ext}`,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // Update swatch
  await supabase
    .from('swatches')
    .update({
      storage_path: storagePath,
      file_size_kb: Math.round(imageBuffer.length / 1024),
    })
    .eq('id', swatchId);

  return NextResponse.json({
    success: true,
    swatch_name: swatch.name,
    design: attrs.FABRIC_DESIGN,
    cannon_url: cannonUrls.pageUrl,
    image_url: sourceUrl,
    size_kb: Math.round(imageBuffer.length / 1024),
  });
}

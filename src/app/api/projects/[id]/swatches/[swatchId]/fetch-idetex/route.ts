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

// Brands sourced from Idetex (idetex.cl). Extend as new brands are discovered.
const IDETEX_BRANDS = ['valencia', 'illusions'];

// ML COMFORTER_MATTRESS_SIZE / MATTRESS_SIZE → Idetex URL slug suffix
const PLAZAS_TO_IDETEX_SIZE: Record<string, string> = {
  '1 plaza': 'single',
  '1.5 plazas': 'single',
  '2 plazas': 'queen',
  '2.5 plazas': 'king',
  '3 plazas': 'super-king',
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildIdetexQuery(attrs: Record<string, string>): string {
  // Strip "MF " prefix used in BANVA model naming on ML (e.g., "MF Embossed" → "embossed").
  const model = (attrs.MODEL || '').replace(/^MF\s+/i, '');
  const parts = [
    attrs.COMFORTER_TYPE,
    attrs.BRAND,
    model,
    attrs.FABRIC_DESIGN || attrs.COLOR,
  ].filter(Boolean).map(normalize);
  return parts.join(' ');
}

function getSizeSlug(attrs: Record<string, string>): string | null {
  const raw = attrs.COMFORTER_MATTRESS_SIZE || attrs.MATTRESS_SIZE || '';
  return PLAZAS_TO_IDETEX_SIZE[raw.toLowerCase()] || null;
}

async function searchIdetex(query: string): Promise<string[]> {
  const url = `https://idetex.cl/buscar?controller=search&s=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
  if (!res.ok) return [];
  const html = await res.text();
  const matches = html.match(/https:\/\/idetex\.cl\/[^"' >]+\.html/g) || [];
  return Array.from(new Set(matches));
}

function pickProductUrl(urls: string[], sizeSlug: string | null): string | null {
  // Idetex product URLs look like: idetex.cl/{category}/{id}-{slug}.html
  // Filter to product detail pages (path has a numeric prefix after the category).
  const productUrls = urls.filter((u) => /\/\d+-[^/]+\.html$/.test(u));
  if (productUrls.length === 0) return null;
  if (!sizeSlug) return productUrls[0];

  // Prefer URLs whose slug ends in the size word (king, queen, single, super-king).
  const sizeMatch = productUrls.find((u) =>
    new RegExp(`-${sizeSlug}\\.html$`).test(u)
  );
  return sizeMatch || productUrls[0];
}

async function extractOgImage(pageUrl: string): Promise<string | null> {
  const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * POST — Fetch swatch image from idetex.cl using ML item attributes.
 *
 * Flow:
 * 1. SKU → item_id (via ml_items_map, fallback to ML search)
 * 2. Fetch ML attributes (BRAND, MODEL, FABRIC_DESIGN, COMFORTER_TYPE, COMFORTER_MATTRESS_SIZE)
 * 3. Validate brand is in IDETEX_BRANDS allowlist
 * 4. Build search query (without size) → idetex.cl/buscar
 * 5. Filter results by size slug suffix → product page URL
 * 6. Scrape og:image from product page → download → upload
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('id', swatchId)
    .single();

  if (!swatch?.sku_suffix) {
    return NextResponse.json({ error: 'Swatch has no SKU' }, { status: 400 });
  }

  const { data: mlItem } = await inventoryDb
    .from('ml_items_map')
    .select('item_id')
    .eq('sku_venta', swatch.sku_suffix)
    .eq('activo', true)
    .is('variation_id', null)
    .maybeSingle();

  let itemId = mlItem?.item_id;

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

  const item = await mlGet<{
    id: string;
    title: string;
    attributes: Array<{ id: string; value_name: string | null }>;
  }>(`/items/${itemId}?attributes=id,title,attributes`);

  if (!item?.attributes) {
    return NextResponse.json({ error: 'Could not fetch item attributes' }, { status: 502 });
  }

  const attrs: Record<string, string> = {};
  for (const attr of item.attributes) {
    if (attr.value_name) {
      attrs[attr.id] = attr.value_name;
    }
  }

  const brand = (attrs.BRAND || '').toLowerCase();
  if (!IDETEX_BRANDS.some((b) => brand.includes(b))) {
    return NextResponse.json({
      error: `Brand "${attrs.BRAND || 'unknown'}" not in Idetex catalog. Supported: ${IDETEX_BRANDS.join(', ')}.`,
      brand: attrs.BRAND,
    }, { status: 400 });
  }

  const query = buildIdetexQuery(attrs);
  if (!query) {
    return NextResponse.json({ error: 'Could not build Idetex search query — missing attributes' }, { status: 400 });
  }

  const sizeSlug = getSizeSlug(attrs);

  console.log(`[fetch-idetex] query="${query}" sizeSlug="${sizeSlug}"`);

  const urls = await searchIdetex(query);
  const productUrl = pickProductUrl(urls, sizeSlug);

  if (!productUrl) {
    return NextResponse.json({
      error: 'No matching product on idetex.cl',
      query,
      size_attempted: sizeSlug,
      results_found: urls.length,
    }, { status: 404 });
  }

  console.log(`[fetch-idetex] matched product: ${productUrl}`);

  const ogImage = await extractOgImage(productUrl);
  if (!ogImage) {
    return NextResponse.json({
      error: 'Could not extract image from product page',
      product_url: productUrl,
    }, { status: 502 });
  }

  console.log(`[fetch-idetex] downloading image: ${ogImage}`);

  const imgRes = await fetch(ogImage, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' } });
  const contentType = imgRes.headers.get('content-type') || '';
  if (!imgRes.ok || !contentType.startsWith('image/')) {
    return NextResponse.json({
      error: 'Image download failed',
      image_url: ogImage,
      status: imgRes.status,
    }, { status: 502 });
  }

  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  if (imageBuffer.length < 1000) {
    return NextResponse.json({
      error: 'Downloaded image is too small (likely a placeholder)',
      bytes: imageBuffer.length,
      image_url: ogImage,
    }, { status: 502 });
  }

  const ext = ogImage.match(/\.(png|jpg|jpeg|webp)/i)?.[1].toLowerCase() || 'jpg';
  const storageName = `${crypto.randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const storagePath = `projects/${projectId}/swatches/${storageName}`;

  if (swatch.storage_path) {
    await supabase.storage.from('images').remove([swatch.storage_path]);
  }

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, imageBuffer, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

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
    design: attrs.FABRIC_DESIGN || attrs.COLOR,
    brand: attrs.BRAND,
    size: attrs.COMFORTER_MATTRESS_SIZE || attrs.MATTRESS_SIZE,
    product_url: productUrl,
    image_url: ogImage,
    size_kb: Math.round(imageBuffer.length / 1024),
  });
}

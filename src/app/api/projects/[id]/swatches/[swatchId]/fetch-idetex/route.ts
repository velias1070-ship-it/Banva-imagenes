import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import {
  isIdetexSku,
  resolveIdetexProductUrl,
  extractAllProductImages,
} from '@/lib/idetex';

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
 * POST — Replace a swatch's image with the first product photo from idetex.cl.
 *
 * Provider validation goes through productos.proveedor (banvabodega) which is
 * the source of truth for Idetex-sourced SKUs across product families.
 * URL resolution uses the shared scored resolver in src/lib/idetex.ts.
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
    if (searchResult?.results?.[0]) itemId = searchResult.results[0];
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
    if (attr.value_name) attrs[attr.id] = attr.value_name;
  }

  const provider = await isIdetexSku(swatch.sku_suffix, attrs);
  if (!provider.ok) {
    return NextResponse.json({
      error: `Not an Idetex SKU — ${provider.reason}`,
    }, { status: 400 });
  }

  const { result: match, debug } = await resolveIdetexProductUrl(attrs, item.title);

  if (!match) {
    return NextResponse.json({
      error: 'Could not find product on idetex.cl with confident match',
      debug,
    }, { status: 404 });
  }

  console.log(`[fetch-idetex] ${swatch.sku_suffix} → ${match.url} (score=${match.score}, q="${match.query}")`);

  const images = await extractAllProductImages(match.url);
  if (images.length === 0) {
    return NextResponse.json({
      error: 'Could not extract image from product page',
      product_url: match.url,
    }, { status: 502 });
  }

  const ogImage = images[0];

  const imgRes = await fetch(ogImage, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
  });
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
    product_url: match.url,
    score: match.score,
    image_url: ogImage,
    size_kb: Math.round(imageBuffer.length / 1024),
  });
}

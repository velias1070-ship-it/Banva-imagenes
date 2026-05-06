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

/**
 * POST /api/projects/{id}/swatches/from-sku
 * Body: { sku: "TXV23QLAT25BE" }
 *
 * 1. Looks up item_id in ml_items_map
 * 2. Fetches item from ML API to get title + first picture
 * 3. Downloads the picture
 * 4. Creates swatch with sku_suffix + uploaded image
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json();
  const sku = (body.sku || '').trim();

  if (!sku) {
    return NextResponse.json({ error: 'SKU is required' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // Check if swatch with this SKU already exists in this project
  const { data: existing } = await supabase
    .from('swatches')
    .select('id, name')
    .eq('project_id', projectId)
    .eq('sku_suffix', sku)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: `SKU ${sku} ya existe como swatch "${existing.name}"` }, { status: 409 });
  }

  // 1. Find item_id in ml_items_map
  const { data: mlItem } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id, titulo')
    .eq('sku_venta', sku)
    .eq('activo', true)
    .is('variation_id', null)
    .maybeSingle();

  if (!mlItem) {
    return NextResponse.json({ error: `SKU ${sku} no encontrado en ml_items_map` }, { status: 404 });
  }

  // 2. Fetch item from ML to get pictures + title
  const item = await mlGet<{
    id: string;
    title: string;
    pictures?: { id: string; secure_url: string }[];
  }>(`/items/${mlItem.item_id}?attributes=id,title,pictures`);

  if (!item) {
    return NextResponse.json({ error: `No se pudo obtener item ${mlItem.item_id} de ML` }, { status: 502 });
  }

  // Extract design + size name from title.
  // Title example:
  //   "Sabanas King Cannon 200 Hilos 2 Plaza Media Full 100 Algodon Express 200 Hilos"
  // We want: design = "Express", size = "King" → name = "Express King".
  const rawTitle = item.title || mlItem.titulo || '';
  const titleWords = rawTitle.split(/\s+/).filter(Boolean);
  // Common Cannon/sabana stopwords. Anything in this list is NOT a design name.
  const STOPWORDS = new Set([
    'cm', 'm',
    'plazas', 'plaza', 'king', 'super',
    'de', 'y', 'en', 'la', 'el', 'con', 'para', 'del',
    'sabanas', 'sabana', 'sábanas', 'sábana',
    'cannon', 'cannonhome',
    'hilos', 'hilo',
    'algodon', 'algodón', 'poliester', 'poliéster',
    'media', 'full', 'twin', 'queen',
    'set', 'juego',
    'mercadolibre', 'envio', 'envío',
  ]);
  const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isStop = (w: string) => STOPWORDS.has(norm(w));
  const isNumeric = (w: string) => /^\d+([.,]\d+)?$/.test(w);

  // Walk left-to-right and pick the FIRST non-stopword non-numeric token whose
  // normalised form is unique in the title — that's typically the design name.
  // Walking left-to-right (vs the previous right-to-left) avoids "Hilos" at the tail.
  const counts = new Map<string, number>();
  for (const w of titleWords) {
    const n = norm(w);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let designName: string | null = null;
  for (const w of titleWords) {
    if (isStop(w) || isNumeric(w) || w.length <= 1) continue;
    const n = norm(w);
    if (counts.get(n) === 1) {
      designName = w;
      break;
    }
  }

  // Find size token (King / Plaza / 1.5 Plazas / etc.)
  let sizeName: string | null = null;
  for (let i = 0; i < titleWords.length; i++) {
    const w = titleWords[i];
    const n = norm(w);
    if (n === 'king' || n === 'super') {
      sizeName = w;
      // "King Super" → use both
      const next = titleWords[i + 1];
      if (next && norm(next) === 'super') sizeName = `${w} ${next}`;
      break;
    }
    if (n === 'plaza' || n === 'plazas') {
      const prev = titleWords[i - 1];
      if (prev && /^\d+([.,]\d+)?$/.test(prev)) {
        sizeName = `${prev} ${w}`;
      } else {
        sizeName = w;
      }
      break;
    }
  }

  let colorName = sku;
  if (designName && sizeName) {
    colorName = `${designName} ${sizeName}`;
  } else if (designName) {
    colorName = designName;
  } else if (sizeName) {
    colorName = sizeName;
  }

  // 3. Download first picture
  let storagePath = '';
  let fileSizeKb = 0;

  if (item.pictures?.length) {
    const pic = item.pictures[0];
    try {
      const imgRes = await fetch(pic.secure_url);
      if (imgRes.ok) {
        const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        fileSizeKb = Math.round(imageBuffer.length / 1024);
        const ext = pic.secure_url.includes('.webp') ? 'webp' : 'jpg';
        const fileName = `${crypto.randomUUID()}.${ext}`;
        storagePath = `projects/${projectId}/swatches/${fileName}`;

        await supabase.storage
          .from('images')
          .upload(storagePath, imageBuffer, {
            contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
            upsert: true,
          });
      }
    } catch (err) {
      console.error('[from-sku] Failed to download picture:', err);
    }
  }

  // 4. Get next display_order
  const { data: lastSwatch } = await supabase
    .from('swatches')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (lastSwatch?.[0]?.display_order ?? -1) + 1;

  // 5. Create swatch
  const { data: swatch, error: insertError } = await supabase
    .from('swatches')
    .insert({
      project_id: projectId,
      name: colorName,
      sku_suffix: sku,
      color_description: colorName,
      storage_path: storagePath,
      display_order: nextOrder,
      file_size_kb: fileSizeKb,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({
    swatch,
    ml_item_id: mlItem.item_id,
    ml_title: item.title || mlItem.titulo,
    has_image: !!storagePath,
  }, { status: 201 });
}

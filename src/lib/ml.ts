import { createClient } from '@supabase/supabase-js';

const ML_API_BASE = 'https://api.mercadolibre.com';
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const MAX_RETRIES = 3;

interface MlConfig {
  id: string;
  seller_id: string;
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
}

// Connects to the inventory Supabase (productos, ml_config, ml_items_map)
// Falls back to the app's Supabase if inventory vars not set
function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

// Mutex to prevent concurrent refreshes
let _refreshPromise: Promise<string> | null = null;

export async function ensureValidToken(): Promise<string> {
  // If a refresh is already in progress, wait for it
  if (_refreshPromise) return _refreshPromise;

  const supabase = getInventorySupabase();

  const { data: config, error } = await supabase
    .from('ml_config')
    .select('*')
    .eq('id', 'main')
    .single();

  if (error || !config) {
    throw new Error(`Failed to read ml_config: ${error?.message || 'not found'}`);
  }

  const mlConfig = config as MlConfig;
  const expiresAt = new Date(mlConfig.token_expires_at).getTime();
  const now = Date.now();

  // Token still valid with buffer
  if (expiresAt - now > TOKEN_BUFFER_MS) {
    return mlConfig.access_token;
  }

  // Need to refresh — use mutex
  _refreshPromise = refreshToken(mlConfig).finally(() => {
    _refreshPromise = null;
  });

  return _refreshPromise;
}

async function refreshToken(config: MlConfig): Promise<string> {
  const supabase = getInventorySupabase();

  // Re-read config in case another process already refreshed
  const { data: freshConfig } = await supabase
    .from('ml_config')
    .select('access_token, token_expires_at')
    .eq('id', 'main')
    .single();

  if (freshConfig) {
    const freshExpiry = new Date(freshConfig.token_expires_at).getTime();
    if (freshExpiry - Date.now() > TOKEN_BUFFER_MS) {
      return freshConfig.access_token;
    }
  }

  // Actually refresh
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${ML_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: config.client_id,
          client_secret: config.client_secret,
          refresh_token: config.refresh_token,
        }),
      });

      if (res.status >= 400 && res.status < 500) {
        const errBody = await res.text();
        throw new Error(`ML OAuth ${res.status}: ${errBody} (not retrying)`);
      }

      if (!res.ok) {
        throw new Error(`ML OAuth ${res.status}`);
      }

      const data = await res.json();
      const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

      // Save new tokens
      await supabase
        .from('ml_config')
        .update({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          token_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 'main');

      return data.access_token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry 4xx errors
      if (msg.includes('not retrying')) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  throw new Error('Token refresh failed after all retries');
}

// Raw GET request to ML API
export async function mlGet<T = unknown>(path: string): Promise<T> {
  const token = await ensureValidToken();
  const url = path.startsWith('http') ? path : `${ML_API_BASE}${path}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ML API GET ${path} → ${res.status}: ${body}`);
  }

  return res.json();
}

// Raw PUT request to ML API
export async function mlPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const token = await ensureValidToken();
  const url = path.startsWith('http') ? path : `${ML_API_BASE}${path}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ML API PUT ${path} → ${res.status}: ${errBody}`);
  }

  return res.json();
}

// Raw POST request to ML API
export async function mlPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const token = await ensureValidToken();
  const url = path.startsWith('http') ? path : `${ML_API_BASE}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ML API POST ${path} → ${res.status}: ${errBody}`);
  }

  return res.json();
}

// Upload image to ML from a URL — downloads it first then uploads as buffer
export async function mlUploadImageFromUrl(sourceUrl: string): Promise<{ id: string }> {
  const imgRes = await fetch(sourceUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image from ${sourceUrl.substring(0, 80)}: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const ext = sourceUrl.includes('.png') ? 'png' : 'jpg';
  return mlUploadImageBuffer(buffer, `image.${ext}`);
}

// Upload image to ML from binary buffer
export async function mlUploadImageBuffer(buffer: Buffer, filename: string): Promise<{ id: string }> {
  const token = await ensureValidToken();

  const formData = new FormData();
  formData.append('file', new Blob([buffer as BlobPart]), filename);

  const res = await fetch(`${ML_API_BASE}/pictures/items/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ML picture upload failed ${res.status}: ${errBody}`);
  }

  return res.json();
}

// Update pictures on a listing using picture IDs (must be already-uploaded to ML).
// Do NOT build a wrapper that takes source URLs: ML's async download from external URLs
// is unreliable and can leave pictures in permanent "processing-image" placeholder state.
// Always upload binaries via mlUploadImageFromUrl / mlUploadImageBuffer first.
export async function mlUpdateItemPictures(
  itemId: string,
  pictureIds: string[]
): Promise<unknown> {
  return mlPut(`/items/${itemId}`, {
    pictures: pictureIds.map((id) => ({ id })),
  });
}

// Fila de ml_items_map relevante para resolver un SKU a su item_id.
interface MlItemsMapRow {
  item_id: string | null;
  sku_venta: string | null;
  sku: string | null;
  ultimo_sync: string | null;
}

// Respuesta del multiget de ML (/items?ids=...): array de envelopes { code, body }.
interface MlMultigetEntry {
  code: number;
  body: { id?: string; catalog_listing?: boolean };
}

// Resultado del resolver: item_id elegido + flags de diagnostico.
export interface ResolveItemIdResult {
  item_id: string | null;
  is_catalog: boolean;
  candidate_count: number;
  all_item_ids: string[];
}

/**
 * Resuelve un sku_venta al item_id de ML que corresponde subir/editar.
 *
 * El bug historico era usar .maybeSingle()/.single(): cuando un SKU tiene
 * varias publicaciones (tipico: una tradicional + una de catalogo), esas
 * llamadas fallan o devuelven la fila equivocada. Aca traemos TODAS las filas
 * y, si hay ambiguedad, preferimos la publicacion TRADICIONAL (catalog_listing
 * = false) porque es la editable (las de catalogo heredan fotos/titulo de la
 * ficha y rechazan PUT de pictures).
 */
export async function resolveItemIdForSku(skuVenta: string): Promise<ResolveItemIdResult> {
  const supabase = getInventorySupabase();

  // Traemos todas las publicaciones activas y sin variacion del SKU.
  // Match por sku_venta (preferido) o por la columna sku (respaldo legacy,
  // porque sku_venta puede venir null en filas antiguas).
  // Envolvemos el valor en comillas dobles para que ,/./() sean literales en
  // PostgREST y removemos "/\ (que romperian el filtro): el resolver se llama
  // server-side con SKUs crudos, asi que no confiamos en la forma del input.
  const safeSku = skuVenta.replace(/["\\]/g, '');
  const { data, error } = await supabase
    .from('ml_items_map')
    .select('item_id, sku_venta, sku, ultimo_sync')
    .or(`sku_venta.eq."${safeSku}",sku.eq."${safeSku}"`)
    .eq('activo', true)
    .is('variation_id', null);

  if (error || !data || data.length === 0) {
    return { item_id: null, is_catalog: false, candidate_count: 0, all_item_ids: [] };
  }

  const rows = data as MlItemsMapRow[];

  // Priorizamos las filas que matchean por sku_venta sobre las que solo
  // matchean por sku (respaldo legacy). Si hay matches por sku_venta, esos mandan.
  const skuVentaRows = rows.filter((r) => r.sku_venta === skuVenta);
  const effectiveRows = skuVentaRows.length > 0 ? skuVentaRows : rows;

  // Solo filas con item_id no nulo son candidatas reales.
  const candidates = effectiveRows.filter(
    (r): r is MlItemsMapRow & { item_id: string } => typeof r.item_id === 'string' && r.item_id.length > 0
  );

  const allItemIds = candidates.map((r) => r.item_id);
  const candidateCount = candidates.length;

  if (candidateCount === 0) {
    return { item_id: null, is_catalog: false, candidate_count: 0, all_item_ids: [] };
  }

  // Caso simple: una sola publicacion. No gastamos una llamada extra a ML;
  // asumimos tradicional (is_catalog=false) y el guard del upload lo revalida.
  if (candidateCount === 1) {
    return {
      item_id: candidates[0].item_id,
      is_catalog: false,
      candidate_count: 1,
      all_item_ids: allItemIds,
    };
  }

  // Ordenamos por ultimo_sync desc para el desempate y el fallback.
  const byRecency = [...candidates].sort(
    (a, b) => (b.ultimo_sync ? Date.parse(b.ultimo_sync) : 0) - (a.ultimo_sync ? Date.parse(a.ultimo_sync) : 0)
  );

  // Caso ambiguo: preguntamos a ML el catalog_listing de cada candidato para
  // poder preferir la publicacion tradicional (editable).
  try {
    const csv = allItemIds.join(',');
    const multiget = await mlGet<MlMultigetEntry[]>(
      `/items?ids=${csv}&attributes=id,catalog_listing`
    );

    // Mapa item_id -> catalog_listing (solo entradas que ML respondio OK).
    const catalogById = new Map<string, boolean>();
    for (const entry of multiget) {
      if (entry.code === 200 && entry.body?.id) {
        catalogById.set(entry.body.id, entry.body.catalog_listing === true);
      }
    }

    // Tradicionales = catalog_listing explicitamente false. Recorremos en orden
    // de recency para que el primer match ya sea el mas reciente.
    const tradicional = byRecency.find((r) => catalogById.get(r.item_id) === false);
    if (tradicional) {
      return {
        item_id: tradicional.item_id,
        is_catalog: false,
        candidate_count: candidateCount,
        all_item_ids: allItemIds,
      };
    }

    // Todas son de catalogo (o sin dato fiable): devolvemos la primera y marcamos catalogo.
    return {
      item_id: byRecency[0].item_id,
      is_catalog: catalogById.get(byRecency[0].item_id) === true,
      candidate_count: candidateCount,
      all_item_ids: allItemIds,
    };
  } catch {
    // Falla de red en el multiget: no rompemos el flujo. Caemos a la fila mas
    // reciente y asumimos tradicional (el guard del upload revalida).
    return {
      item_id: byRecency[0].item_id,
      is_catalog: false,
      candidate_count: candidateCount,
      all_item_ids: allItemIds,
    };
  }
}

/**
 * Revalida contra ML si una publicacion es de catalogo (catalog_listing=true).
 * Sirve como guard antes de subir/editar fotos: las de catalogo rechazan el PUT.
 * En error de red devolvemos false a proposito: preferimos no bloquear subidas
 * validas por un fallo transitorio (el PUT real fallara claro si fuese catalogo).
 */
export async function isCatalogListing(itemId: string): Promise<boolean> {
  try {
    const item = await mlGet<{ catalog_listing?: boolean }>(
      `/items/${itemId}?attributes=catalog_listing`
    );
    return item.catalog_listing === true;
  } catch {
    return false;
  }
}

/**
 * MercadoLibre API client — lightweight version for Banva-imagenes.
 * Reads credentials from ml_config table in inventario Supabase
 * (qaircihuiafgnnrwcjls.supabase.co).
 */
import { createClient } from '@supabase/supabase-js';

const ML_API = 'https://api.mercadolibre.com';

interface MLConfig {
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  client_id: string;
  client_secret: string;
  seller_id: string;
}

function getInventarioSupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL;
  const key = process.env.INVENTORY_SUPABASE_KEY;
  if (!url || !key) throw new Error('Missing INVENTORY_SUPABASE_URL or INVENTORY_SUPABASE_KEY');
  return createClient(url, key);
}

async function getMLConfig(): Promise<MLConfig | null> {
  const sb = getInventarioSupabase();
  const { data } = await sb.from('ml_config').select('*').eq('id', 'main').single();
  return data as MLConfig | null;
}

async function saveMLConfig(updates: Partial<MLConfig>) {
  const sb = getInventarioSupabase();
  await sb.from('ml_config').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', 'main');
}

let _refreshPromise: Promise<string | null> | null = null;

async function ensureValidToken(): Promise<string | null> {
  const config = await getMLConfig();
  if (!config?.access_token) return null;

  const expiresAt = new Date(config.token_expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return config.access_token;
  }

  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const fresh = await getMLConfig();
      if (fresh) {
        const freshExpiry = new Date(fresh.token_expires_at).getTime();
        if (Date.now() < freshExpiry - 5 * 60 * 1000) return fresh.access_token;
      }

      const cfg = fresh || config;
      if (!cfg.client_id || !cfg.client_secret || !cfg.refresh_token) return null;

      const resp = await fetch(`${ML_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: cfg.client_id,
          client_secret: cfg.client_secret,
          refresh_token: cfg.refresh_token,
        }),
      });

      if (!resp.ok) return null;

      const data = await resp.json();
      await saveMLConfig({
        access_token: data.access_token,
        refresh_token: data.refresh_token || cfg.refresh_token,
        token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      });

      return data.access_token as string;
    } catch {
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

export async function mlGet<T = unknown>(path: string): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error(`[ML] GET ${path} failed:`, resp.status);
    return null;
  }

  return resp.json() as Promise<T>;
}

export async function getSellerItems(): Promise<string[]> {
  const config = await getMLConfig();
  if (!config?.seller_id) return [];

  const allIds: string[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const result = await mlGet<{ results: string[]; paging: { total: number } }>(
      `/users/${config.seller_id}/items/search?limit=${limit}&offset=${offset}`
    );
    if (!result?.results?.length) break;
    allIds.push(...result.results);
    offset += limit;
    if (offset >= result.paging.total) break;
  }

  return allIds;
}

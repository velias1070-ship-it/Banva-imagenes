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

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Mutex to prevent concurrent refreshes
let _refreshPromise: Promise<string> | null = null;

export async function ensureValidToken(): Promise<string> {
  // If a refresh is already in progress, wait for it
  if (_refreshPromise) return _refreshPromise;

  const supabase = getSupabase();

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
  const supabase = getSupabase();

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

// Upload image to ML from a URL (e.g. Supabase storage public URL)
export async function mlUploadImageFromUrl(sourceUrl: string): Promise<{ id: string }> {
  return mlPost('/pictures/items/upload', { source: sourceUrl });
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

// Update pictures on a listing
export async function mlUpdateItemPictures(
  itemId: string,
  pictureIds: string[]
): Promise<unknown> {
  return mlPut(`/items/${itemId}`, {
    pictures: pictureIds.map((id) => ({ id })),
  });
}

// Replace pictures on a listing using source URLs
export async function mlReplaceItemPicturesFromUrls(
  itemId: string,
  sourceUrls: string[]
): Promise<unknown> {
  return mlPut(`/items/${itemId}`, {
    pictures: sourceUrls.map((url) => ({ source: url })),
  });
}

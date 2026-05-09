import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
loadEnv({ path: resolve(process.cwd(), '.env.local') });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const sb = `${url}/storage/v1`;
  const headers = { Authorization: `Bearer ${key}` };

  const swatchSearch = await fetch(`${sb}/object/list/images`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefix: 'projects/611886d1-dedf-4a1a-9942-5f4bf4ed86c2/swatches/',
      limit: 100,
    }),
  });
  const list = await swatchSearch.json();
  const found = list.find((f: { name: string }) => f.name.includes('09c7a01c'));
  if (!found) {
    console.error('swatch not found, listing:', list.map((f: { name: string }) => f.name));
    return;
  }
  const path = `projects/611886d1-dedf-4a1a-9942-5f4bf4ed86c2/swatches/${found.name}`;
  const r = await fetch(`${sb}/object/images/${path}`, { headers });
  if (!r.ok) { console.error('fetch fail', r.status); return; }
  const ext = found.name.split('.').pop();
  const out = `/tmp/hero_review/turquesa_swatch.${ext}`;
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('saved', out);
}
main();

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
loadEnv({ path: resolve(process.cwd(), '.env.local') });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
async function dl(path: string, out: string) {
  const r = await fetch(`${url}/storage/v1/object/images/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) { console.error(path, r.status, await r.text()); return; }
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('saved', out);
}
async function main() {
  await dl('projects/611886d1-dedf-4a1a-9942-5f4bf4ed86c2/generated/_debug/5e370407-553c-4e93-9fe0-426ecc6467db_attempt1_rejected.png',
          '/tmp/hero_review/roy_attempt1_rejected.png');
}
main();

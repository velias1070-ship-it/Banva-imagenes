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
  if (!r.ok) { console.error(path, r.status); return; }
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('saved', out);
}

async function main() {
  const projectId = '611886d1-dedf-4a1a-9942-5f4bf4ed86c2';
  // canonical = pre-overlay (Pro raw)
  await dl(`projects/${projectId}/generated/115caddb-b1c1-4c6d-bfc0-6346f9697b3b.png`,
           '/tmp/hero_review/jobA_canonical_preoverlay.png');
  // final = post-overlay (lo que Vicente vio)
  await dl(`projects/${projectId}/generated/SPAFL38T10W26_turquesa_lifestyle_v2_115caddb.png`,
           '/tmp/hero_review/jobA_final_postoverlay.png');
  // attempt 0 rejected (Flash distressed)
  await dl(`projects/${projectId}/generated/_debug/115caddb-b1c1-4c6d-bfc0-6346f9697b3b_attempt0_rejected.png`,
           '/tmp/hero_review/jobA_attempt0_rejected.png');
}
main();

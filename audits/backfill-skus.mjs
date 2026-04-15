import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Derive "product family" from a name.
// Heuristic: first 1-2 meaningful words, stripped of size/plaza markers.
function deriveProductFamily(name) {
  if (!name) return null;
  const normalized = name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\d+[pP]$/g, '')      // "25P"
    .replace(/\b\d+x\d+\b/g, '')   // "50x70"
    .replace(/\b\d+[%h]\w*/gi, '') // "100%Pol", "144h"
    .trim();
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return null;
  // Take up to 3 words but stop at size/plaza markers
  const stopWords = new Set(['king', 'plaza', 'plazas', 'queen', 'twin', 'full', 'final', 'prueba']);
  const out = [];
  for (const w of words) {
    if (stopWords.has(w.toLowerCase())) break;
    out.push(w);
    if (out.length >= 3) break;
  }
  if (out.length === 0) return words[0];
  return out.join(' ');
}

function titleCase(family) {
  if (!family) return null;
  return family
    .split(/\s+/)
    .map(w => w[0] ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

// Check that target tables exist
const { error: checkSkus } = await supa.from('skus').select('id').limit(1);
if (checkSkus) {
  console.error('ERROR: tabla skus no existe todavia. Aplica la migration primero.');
  console.error(checkSkus.message);
  process.exit(1);
}
const { error: checkPivot } = await supa.from('project_skus').select('project_id').limit(1);
if (checkPivot) {
  console.error('ERROR: tabla project_skus no existe todavia.');
  process.exit(1);
}

// Load all projects
const { data: projects, error: eProjects } = await supa
  .from('projects')
  .select('id, name, category, sku_base, status')
  .order('created_at', { ascending: true }); // oldest first so newest updates win
if (eProjects) throw eProjects;

console.log(`Processing ${projects.length} projects...`);

// Group by sku_base (skipping nulls)
const byCode = new Map();
const withoutSku = [];
for (const p of projects) {
  if (p.sku_base && p.sku_base.trim()) {
    const code = p.sku_base.trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(p);
  } else {
    withoutSku.push(p);
  }
}

console.log(`\n→ ${byCode.size} SKUs únicos desde sku_base`);
console.log(`→ ${withoutSku.length} proyectos sin sku_base (quedan sin link — requieren decisión manual)`);

// Create/upsert skus and project_skus links
let created = 0;
let linked = 0;
for (const [code, plist] of byCode) {
  // Use the most recent project (last in list since we sorted ASC) for the display name
  const latest = plist[plist.length - 1];
  const family = titleCase(deriveProductFamily(latest.name));

  const { data: skuRow, error: eSku } = await supa
    .from('skus')
    .upsert({
      code,
      name: latest.name,
      product_family: family,
      category: latest.category,
      status: 'active',
    }, { onConflict: 'code' })
    .select('id')
    .single();

  if (eSku) {
    console.error(`ERROR creando sku ${code}:`, eSku.message);
    continue;
  }
  created++;

  for (const p of plist) {
    const { error: eLink } = await supa
      .from('project_skus')
      .upsert({ project_id: p.id, sku_id: skuRow.id }, { onConflict: 'project_id,sku_id' });
    if (eLink) {
      console.error(`ERROR linking ${p.id} ↔ ${code}:`, eLink.message);
      continue;
    }
    linked++;
  }

  console.log(`  ✓ ${code}  [${family}]  (${plist.length} proyecto${plist.length > 1 ? 's' : ''})`);
}

console.log(`\n✓ SKUs creados/actualizados: ${created}`);
console.log(`✓ Links project_skus: ${linked}`);
console.log(`\nProyectos sin sku_base (revisar manualmente):`);
for (const p of withoutSku) {
  console.log(`  - ${p.name}  (${p.category})`);
}

console.log('\nDONE');

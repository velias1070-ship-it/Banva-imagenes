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

// Find the orphan Polar project
const { data: orphan } = await supa
  .from('projects')
  .select('id, name, category, sku_base')
  .eq('name', 'Jgo Sabana Polar AF 100%Pol')
  .is('sku_base', null)
  .maybeSingle();

if (!orphan) {
  console.log('No encuentro el proyecto huerfano "Jgo Sabana Polar AF 100%Pol"');
  process.exit(0);
}
console.log('Orphan encontrado:', orphan.id);

// Create or reuse SKU
const code = 'jgo-sabana-polar-af-100pol';
const { data: sku, error: eSku } = await supa
  .from('skus')
  .upsert({
    code,
    name: 'Jgo Sabana Polar AF 100%Pol',
    product_family: 'Jgo Sabana Polar',
    category: orphan.category,
    status: 'active',
  }, { onConflict: 'code' })
  .select('id, code, name, product_family')
  .single();

if (eSku) {
  console.error('Error creando SKU:', eSku.message);
  process.exit(1);
}
console.log('SKU listo:', sku);

// Link the pivot
const { error: eLink } = await supa
  .from('project_skus')
  .upsert({ project_id: orphan.id, sku_id: sku.id }, { onConflict: 'project_id,sku_id' });
if (eLink) {
  console.error('Error linking:', eLink.message);
  process.exit(1);
}
console.log('Link project_skus OK');

// Also align the existing Polar SKU's family (should already be "Jgo Sabana Polar" but make sure)
const { data: existing } = await supa
  .from('skus')
  .select('id, code, name, product_family')
  .eq('code', 'jgo-sabana-polar-af-100pol-liso-malva-0')
  .maybeSingle();

if (existing && existing.product_family !== 'Jgo Sabana Polar') {
  const { error } = await supa
    .from('skus')
    .update({ product_family: 'Jgo Sabana Polar' })
    .eq('id', existing.id);
  if (error) console.error('Error aligning existing:', error.message);
  else console.log('Familia del SKU existente alineada a "Jgo Sabana Polar"');
} else if (existing) {
  console.log('SKU existente ya esta en familia "Jgo Sabana Polar":', existing.code);
}

// Show the final Polar family
const { data: family } = await supa
  .from('skus')
  .select('code, name, product_family')
  .eq('product_family', 'Jgo Sabana Polar');

console.log('\nFamilia "Jgo Sabana Polar" ahora contiene:');
console.table(family);

/**
 * Prueba de GET /api/projects/{id}/results-with-listings: la sección
 * Resultados muestra los swatches del proyecto aunque todavía no se haya
 * generado nada (antes volvía vacía hasta que «Importar de Cannon» creaba una
 * generación). Con generaciones, cada imagen va con su swatch. Si falla la
 * lectura de generaciones o de swatches responde 500, no una lista vacía.
 *
 * Los swatches van sin SKU para no llamar a ML: esa parte no cambia.
 *
 * Uso: npx tsx scripts/test-resultados-sin-generar.ts  (no llama a ninguna API)
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://app-db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-prueba';
process.env.INVENTORY_SUPABASE_URL = 'http://inventario.test';
process.env.INVENTORY_SUPABASE_KEY = 'clave-de-prueba';

import { NextRequest } from 'next/server';

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}

const swatch = (id: string, orden: number) => ({
  id,
  project_id: 'P1',
  name: `Color ${id}`,
  sku_suffix: null,
  color_description: null,
  storage_path: `sw/${id}.png`,
  display_order: orden,
  marked_done_at: null,
});

const base: Record<string, Record<string, unknown>[]> = {
  generation_batches: [],
  generation_jobs: [],
  swatches: [swatch('S1', 1), swatch('S2', 2), { ...swatch('OTRO', 1), project_id: 'P2' }],
};
let caida: string | null = null;

globalThis.fetch = (async (entrada: unknown) => {
  const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
  const tabla = url.pathname.replace('/rest/v1/', '');
  if (url.host !== 'app-db.test' || !(tabla in base)) return new Response('[]', { status: 404 });
  if (tabla === caida) return new Response(JSON.stringify({ message: 'caída simulada' }), { status: 500 });
  let filas = base[tabla];
  for (const [k, v] of url.searchParams) {
    if (v.startsWith('eq.')) filas = filas.filter((f) => String(f[k]) === v.slice(3));
    else if (v.startsWith('in.(')) {
      const valores = v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''));
      filas = filas.filter((f) => valores.includes(String(f[k])));
    }
  }
  return new Response(JSON.stringify(filas), { status: 200 });
}) as typeof fetch;

async function main() {
  const ruta = await import('../src/app/api/projects/[id]/results-with-listings/route');
  const pedir = async () => {
    const res = await ruta.GET(new NextRequest('http://app.test/api/projects/P1/results-with-listings'), {
      params: Promise.resolve({ id: 'P1' }),
    });
    return { status: res.status, cuerpo: (await res.json()) as { swatch: { id: string }; jobs: { id: string }[] }[] };
  };

  // Proyecto recién creado: swatches cargados, nada generado.
  const nuevo = await pedir();
  const ids = Array.isArray(nuevo.cuerpo) ? nuevo.cuerpo.map((g) => g.swatch.id).join(',') : JSON.stringify(nuevo.cuerpo);
  afirmar(nuevo.status === 200 && ids === 'S1,S2', `sin generar: salen los swatches del proyecto (${nuevo.status} ${ids})`);
  afirmar(Array.isArray(nuevo.cuerpo) && nuevo.cuerpo.every((g) => g.jobs.length === 0), 'sin generar: sin imágenes');

  // Con una generación: la imagen va con su swatch.
  base.generation_batches = [{ id: 'B1', project_id: 'P1' }, { id: 'B9', project_id: 'P2' }];
  base.generation_jobs = [
    { id: 'J1', batch_id: 'B1', swatch_id: 'S2', status: 'completed', created_at: '2026-09-29T10:00:00Z', hero_shot: null, swatch: null },
    { id: 'J9', batch_id: 'B9', swatch_id: 'OTRO', status: 'completed', created_at: '2026-09-29T11:00:00Z', hero_shot: null, swatch: null },
  ];
  const generado = await pedir();
  const s2 = generado.cuerpo.find((g) => g.swatch.id === 'S2');
  afirmar(
    generado.status === 200 && generado.cuerpo.length === 2 && s2?.jobs.map((j) => j.id).join(',') === 'J1',
    `con generación: la imagen va con su swatch, sin las de otro proyecto (${JSON.stringify(generado.cuerpo.map((g) => [g.swatch.id, g.jobs.map((j) => j.id)]))})`,
  );

  // Una lectura que falla no se disfraza de «no hay nada».
  for (const tabla of ['generation_batches', 'swatches']) {
    caida = tabla;
    const r = await pedir();
    afirmar(r.status === 500, `caída de ${tabla} → 500 (${r.status})`);
  }
  caida = null;

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

export {};

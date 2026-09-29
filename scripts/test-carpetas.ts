/**
 * Prueba de las carpetas de proyectos (src/lib/carpetas.ts y
 * POST /api/projects/carpeta).
 *
 * - Junta las medidas de un producto con los nombres reales de ML (Atenas:
 *   1.5, 2 plazas, King y Super King, esta última cortada a «Atena»), sin
 *   juntar productos distintos (sábanas de 300 y 500 hilos). Bruselas 1.5 y 2
 *   plazas NO se juntan solas (ML les puso palabras distintas): se mueven a mano.
 * - La carpeta guardada manda; si no hay, la del producto de su familia
 *   principal; sin familia, «Sin familia de ML».
 * - Proyecto nuevo: guarda la carpeta puesta a mano donde está la mayoría de
 *   los otros proyectos de su producto (cualquier medida); si no, no guarda
 *   nada y sigue a la del producto. Un empate lo gana la del producto.
 * - La lista: carpetas por nombre con «Sin familia de ML» al final; adentro, lo
 *   más nuevo primero.
 * - POST /api/projects/carpeta: valida, guarda metadata.carpeta sin perder las
 *   otras llaves, dice cuáles no encontró y responde 500 si falla un guardado.
 *
 * Uso: npx tsx scripts/test-carpetas.ts  (no llama a ninguna API)
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://app-db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-prueba';

import type { ProductGroup } from '../src/lib/familias-ml';
import { calcularVariantesNuevas, type ProyectoSkus } from '../src/lib/proyectos-familia';
import {
  SIN_FAMILIA,
  agruparEnCarpetas,
  carpetaParaNuevo,
  carpetasDeProyectos,
  claveProducto,
  nombreProducto,
} from '../src/lib/carpetas';

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}

const ATENAS = [
  'Cubrecamas 1.5 Plaza Quilt Cobertor Acolchado Liviano Atenas',
  'Cubrecamas 2 Plazas Quilt Cobertor Acolchado Liviano Atenas',
  'Cubrecamas King Quilt Cobertores Acolchado Liviano Atenas',
  'Cubrecamas Super King Quilt Cobertor Acolchado Liviano Atena',
];
const BRUSELAS_15 = 'Cubrecamas 1.5 Cobertor Plaza Y Media Quilt Bruselas Liviano';
const BRUSELAS_2 = 'Cubrecamas 2 Plaza Quilt Cobertor Acolchado Liviano Bruselas';

function familia(base_name: string, skus: string[]): ProductGroup {
  return {
    base_name,
    slug: base_name,
    tamano: '',
    categoria: '',
    family_name: base_name,
    variantes: skus.map((sku) => ({ sku, color: sku, color_slug: sku, source: 'ml' as const })),
  };
}

function proyecto(
  id: string,
  skus: string[],
  carpeta: string | null = null,
  created_at = '2026-09-01',
  enGrilla: string[] = skus,
): ProyectoSkus {
  const s = new Set(skus.map((x) => x.toUpperCase()));
  return { id, name: id, skus: s, enGrilla: new Set(enGrilla.map((x) => x.toUpperCase())), carpeta, status: 'draft', created_at };
}

async function main() {
  // --- Juntar medidas ---
  const claves = new Set(ATENAS.map(claveProducto));
  afirmar(claves.size === 1, `las 4 medidas de Atenas son un producto (${[...claves].join(' / ')})`);
  afirmar(
    nombreProducto(ATENAS[0]) === 'Cubrecamas Quilt Cobertor Acolchado Liviano Atenas',
    `nombre sin la medida (${nombreProducto(ATENAS[0])})`,
  );
  afirmar(
    claveProducto('Sabanas Canon 2 Plazas Queen Full 100 Algodon King 300') !==
      claveProducto('Sabanas Canon 2 Plazas Queen Full 100 Algodon King 500'),
    'sábanas de 300 y 500 hilos quedan separadas',
  );
  afirmar(claveProducto(BRUSELAS_15) !== claveProducto(BRUSELAS_2), 'Bruselas 1.5 y 2 plazas no se juntan solas (límite declarado)');
  afirmar(nombreProducto('Juego 4 Toalla Bano Algodon 400g').includes('4'), 'un número que no es medida se queda en el nombre');

  // --- Carpeta de cada proyecto ---
  const familias = [
    familia(ATENAS[0], ['AT15A', 'AT15B']),
    familia(ATENAS[1], ['AT20A', 'AT20B', 'AT20C']),
    familia(BRUSELAS_15, ['BR15A', 'BR15B']),
    familia(BRUSELAS_2, ['BR20A']),
  ];
  const nombreAtenas = 'Cubrecamas Quilt Cobertor Acolchado Liviano Atenas';
  const nombreBr15 = nombreProducto(BRUSELAS_15);
  const proyectos = [
    proyecto('at15', ['AT15A']),
    proyecto('at20', ['AT20A', 'at20b']),
    proyecto('br15', ['BR15A', 'BR15B']),
    proyecto('guardado', ['AT15A'], 'Quilt Atenas viejo'),
    proyecto('mixto', ['AT15A', 'BR15A', 'BR15B']), // más de Bruselas
    proyecto('sin-sku', []),
  ];
  const c = carpetasDeProyectos(familias, proyectos);
  afirmar(c.get('at15') === nombreAtenas && c.get('at20') === nombreAtenas, 'Atenas 1.5 y 2 plazas en la misma carpeta');
  afirmar(c.get('guardado') === 'Quilt Atenas viejo', 'la carpeta guardada manda');
  afirmar(c.get('mixto') === nombreBr15, `el mixto va a la familia donde tiene más SKUs (${c.get('mixto')})`);
  afirmar(c.get('sin-sku') === SIN_FAMILIA, 'sin familia → «Sin familia de ML»');
  afirmar(carpetasDeProyectos([], proyectos, 'Sin agrupar').get('at15') === 'Sin agrupar', 'sin familias leídas → la carpeta que se pasa');
  // King («Cobertores», 1 variante) y Super King («Atena», 3): el nombre sale de la que tiene más.
  const kings = [familia(ATENAS[2], ['K1']), familia(ATENAS[3], ['SK1', 'SK2', 'SK3'])];
  const cKing = carpetasDeProyectos(kings, [proyecto('k', ['K1'])]).get('k');
  afirmar(cKing === 'Cubrecamas Quilt Cobertor Acolchado Liviano Atena', `el nombre de la carpeta sale de la familia con más variantes (${cKing})`);

  // --- Proyecto nuevo: guarda carpeta sólo si la mayoría de su producto está en una puesta a mano ---
  const renombrados = [
    proyecto('at15', ['AT15A'], 'Quilt Atenas'),
    proyecto('at15b', ['AT15B'], 'Quilt Atenas'),
    proyecto('nuevo', ['AT20B']), // 2 plazas: otra medida del mismo producto
    // De otro producto: no cuentan (si contaran, empatan 2 a 2 y gana «Aaa»).
    proyecto('br-x', ['BR15A'], 'Aaa otra'),
    proyecto('br-y', ['BR15B'], 'Aaa otra'),
  ];
  afirmar(carpetaParaNuevo(familias, renombrados, 'nuevo') === 'Quilt Atenas', 'el nuevo cae en la carpeta renombrada aunque sea de otra medida');
  afirmar(
    carpetaParaNuevo(familias, [proyecto('viejo', ['AT20A']), proyecto('solo', ['AT20B'])], 'solo') === null,
    'los otros de su producto en la automática → no guarda (sigue a la del producto si ML la renombra)',
  );
  afirmar(carpetaParaNuevo(familias, [proyecto('solo', ['AT20A'])], 'solo') === null, 'sin otros de su producto → no guarda');
  afirmar(carpetaParaNuevo(familias, [proyecto('x', ['NOESTA'])], 'x') === null, 'sin familia → no guarda');
  const conMovido = [
    proyecto('br-a', ['BR15A']),
    proyecto('br-b', ['BR15B']),
    proyecto('movido', ['BR15A'], 'Quilt Atenas'), // mal puesto, movido a mano
    proyecto('br-nuevo', ['BR15B']),
  ];
  afirmar(carpetaParaNuevo(familias, conMovido, 'br-nuevo') === null, 'un proyecto movido no arrastra a los nuevos (2 a 1)');
  const empate = [
    proyecto('br-a', ['BR15A']),
    proyecto('movido', ['BR15B'], 'Atenas quilts'), // antes que «Cubrecamas…» por abecedario
    proyecto('br-nuevo', ['BR15B']),
  ];
  afirmar(carpetaParaNuevo(familias, empate, 'br-nuevo') === null, 'en un empate gana la del producto');

  // --- Lista ---
  const lista = agruparEnCarpetas(familias, [
    proyecto('viejo', ['AT15A'], null, '2026-01-01'),
    proyecto('nuevo', ['AT20A'], null, '2026-09-01'),
    proyecto('sin-sku', []),
    proyecto('b', ['BR20A']),
    proyecto('t', [], 'Toallas'), // después de «Sin…» por abecedario
  ]);
  afirmar(lista[lista.length - 1].nombre === SIN_FAMILIA, '«Sin familia de ML» va al final');
  afirmar(
    JSON.stringify(lista.slice(0, -1).map((x) => x.nombre)) ===
      JSON.stringify([nombreProducto(BRUSELAS_2), nombreAtenas, 'Toallas'].sort((a, b) => a.localeCompare(b, 'es'))),
    'carpetas por nombre',
  );
  const atenas = lista.find((x) => x.nombre === nombreAtenas)!;
  afirmar(atenas.proyectos.map((p) => p.id).join(',') === 'nuevo,viejo', 'adentro, lo más nuevo primero');

  // --- Variantes: la borrada de la grilla que también está en un hermano se ofrece ---
  const vn = calcularVariantesNuevas(familias, [
    proyecto('yo', ['AT20A', 'AT20B'], null, '2026-09-01', ['AT20A']), // borró AT20B
    proyecto('hermano', ['AT20B']), // misma carpeta (Atenas)
    proyecto('ajeno', ['BR15A'], 'Otra'),
  ], 'yo');
  afirmar(JSON.stringify(vn?.borradas) === JSON.stringify(['AT20B']), `borrada que está en un hermano se ofrece (${JSON.stringify(vn?.borradas)})`);
  afirmar(JSON.stringify(vn?.hermanos.map((h) => h.id)) === JSON.stringify(['hermano']), 'hermanos = los de su carpeta');

  // --- POST /api/projects/carpeta ---
  const projects: Record<string, unknown>[] = [
    { id: 'p1', metadata: { variantes: [{ sku: 'A' }], carpeta: 'Vieja' } },
    { id: 'p2', metadata: null },
    { id: 'p3', metadata: { settings: { x: 1 } } },
  ];
  let fallarPatch: string | null = null;
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
    if (url.host !== 'app-db.test' || !url.pathname.endsWith('/projects')) return new Response('[]', { status: 404 });
    const id = url.searchParams.get('id')?.replace('eq.', '');
    const fila = projects.find((p) => p.id === id);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo === 'PATCH') {
      if (id === fallarPatch) return new Response(JSON.stringify({ message: 'caída simulada' }), { status: 500 });
      Object.assign(fila!, JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    const filas = fila ? [{ metadata: fila.metadata }] : [];
    const objeto = new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object');
    if (objeto) {
      return filas.length ? new Response(JSON.stringify(filas[0]), { status: 200 }) : new Response(JSON.stringify({ code: 'PGRST116', message: '0 filas' }), { status: 406 });
    }
    return new Response(JSON.stringify(filas), { status: 200 });
  }) as typeof fetch;

  const ruta = await import('../src/app/api/projects/carpeta/route');
  const post = async (body: unknown) => {
    const res = await ruta.POST(new Request('http://app.test/x', { method: 'POST', body: JSON.stringify(body) }) as never);
    return { status: res.status, body: await res.json() };
  };
  afirmar((await post({ carpeta: 'X' })).status === 400, 'sin project_ids → 400');
  afirmar((await post(null)).status === 400, 'body null → 400');
  afirmar((await post({ project_ids: ['p1'], carpeta: '  ' })).status === 400, 'carpeta vacía → 400');
  afirmar((await post({ project_ids: ['p1'], carpeta: 'x'.repeat(81) })).status === 400, 'carpeta de más de 80 → 400');

  const r = await post({ project_ids: ['p1', 'p2', 'p3', 'p1', 'no-existe'], carpeta: '  Quilt Atenas ' });
  afirmar(r.status === 200 && r.body.actualizados === 3, `guarda las tres, una vez cada una (${JSON.stringify(r.body)})`);
  afirmar(JSON.stringify(r.body.no_encontrados) === JSON.stringify(['no-existe']), 'dice cuál no encontró');
  const m1 = projects[0].metadata as { carpeta: string; variantes: unknown[] };
  afirmar(m1.carpeta === 'Quilt Atenas' && m1.variantes.length === 1, 'guarda la carpeta sin espacios y conserva las variantes');
  afirmar((projects[2].metadata as { settings?: unknown }).settings !== undefined, 'conserva las otras llaves de metadata');

  fallarPatch = 'p2';
  const rErr = await post({ project_ids: ['p1', 'p2'], carpeta: 'Otra' });
  afirmar(rErr.status === 500 && rErr.body.actualizados === 1 && rErr.body.errores?.[0]?.id === 'p2', `falla un guardado → 500 y dice cuál (${JSON.stringify(rErr.body)})`);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

export {};

/**
 * Prueba del buscador de proyectos por SKU (src/lib/busqueda-proyectos.ts y
 * GET /api/projects/indice-busqueda).
 *
 * - Índice: entran los SKU venta publicados en ML o que están en un proyecto
 *   (no los que sólo existen en composicion_venta); el origen y sus unidades
 *   salen de composicion_venta sin importar mayúsculas ni espacios, sin las
 *   filas 'alternativo'; nombres sólo de los orígenes usados.
 * - Buscar un SKU origen trae todos los SKU venta que lo llevan (de a uno,
 *   packs ×2, combos al final), con su proyecto o sin proyecto; por nombre de
 *   origen o por título de ML, sin tildes ni mayúsculas; buscar el quilt (por
 *   SKU o por nombre) no trae la funda del combo, buscar los combos trae todos
 *   sus orígenes; un SKU venta sin origen sale aparte; tope de grupos con los
 *   ocultos contados y proyectos sólo de lo que se muestra.
 * - Ruta: lee composicion_venta y productos pasada la fila 1.000, con orden;
 *   pide tipo_relacion; sin INVENTORY_* o con una caída de la base responde 500.
 *
 * Uso: npx tsx scripts/test-busqueda-proyectos.ts  (no llama a ninguna API)
 */
process.env.INVENTORY_SUPABASE_URL = 'http://inventario.test';
process.env.INVENTORY_SUPABASE_KEY = 'clave-de-prueba';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://app-db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-prueba';

import type { ProductGroup } from '../src/lib/familias-ml';
import type { ProyectoSkus } from '../src/lib/proyectos-familia';
import { armarIndice, buscarSkus, MAX_GRUPOS, type IndiceBusqueda } from '../src/lib/busqueda-proyectos';
import { sinTildes } from '../src/lib/familias-ml';

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}
const tokens = (q: string) => sinTildes(q).split(/\s+/).filter(Boolean);

function familia(base_name: string, variantes: [string, string][]): ProductGroup {
  return {
    base_name,
    slug: base_name,
    tamano: '',
    categoria: '',
    family_name: base_name,
    variantes: variantes.map(([sku, titulo]) => ({ sku, titulo, color: sku, color_slug: sku, source: 'ml' as const })),
  };
}
function proyecto(id: string, skus: string[]): ProyectoSkus {
  const s = new Set(skus);
  return { id, name: id, skus: s, enGrilla: s, carpeta: null, status: 'draft', created_at: null };
}

const familias = [
  familia('Primera', [['SAB1', '']]), // sin título: vale el primero que lo tenga
  familia('Quilt Atenas 1.5', [
    ['QAT15AZ', 'Quilt Atenas 1.5 Plazas Azul'],
    ['PACK2QAT15AZ', 'Pack 2 Quilt Atenas 1.5 Plazas Azul'],
  ]),
  familia('Combo Atenas', [['COMBOAZ ', 'Combo Quilt Atenas Azul Con Funda']]), // con espacio
  familia('Combo Sábana', [['COMBOSAB', 'Combo Sábana Con Quilt']]),
  familia('Sábana', [['SAB1', 'Sábana Polar Café']]),
  familia('Otra', [['QAT15AZ', '']]), // repetido más abajo sin título: no lo pisa
];
const proyectos = [
  proyecto('P1', ['QAT15AZ ']), // con espacio
  proyecto('P2', ['COMBOAZ']),
  proyecto('P3', ['PROYSOLO']),
  proyecto('P4', ['FUNDA1']),
];
const composicion = [
  { sku_venta: 'QAT15AZ', sku_origen: 'QAT15AZ', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'pack2qat15az ', sku_origen: ' qat15az', unidades: 2, tipo_relacion: null }, // minúsculas y espacios
  { sku_venta: 'COMBOAZ', sku_origen: 'QAT15AZ', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'COMBOAZ', sku_origen: 'FUNDA1', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'COMBOSAB', sku_origen: 'QAT15AZ', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'COMBOSAB', sku_origen: 'SAB2', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'FUNDA1', sku_origen: 'FUNDA1', unidades: 1, tipo_relacion: 'componente' },
  { sku_venta: 'MUERTO', sku_origen: 'QAT15AZ', unidades: 3, tipo_relacion: 'componente' }, // no publicada ni en proyecto
  { sku_venta: 'SAB1', sku_origen: 'QAT15AZ', unidades: 1, tipo_relacion: 'alternativo' }, // no lo lleva
];
const productos = [
  { sku: 'QAT15AZ', nombre: 'Cubrecama Atenas 1.5 Azul' }, // el nombre de Bodega no repite el título de ML
  { sku: 'funda1 ', nombre: 'Funda Almohada Azul' }, // minúsculas y espacio
  { sku: 'SAB2', nombre: 'Bajera Lisa Gris' },
  { sku: 'OTRO', nombre: 'No usado' },
];

async function main() {
  // --- Índice ---
  const indice = armarIndice(familias, proyectos, composicion, productos);
  const skus = indice.ventas.map((v) => v.sku).join(',');
  afirmar(
    skus === 'COMBOAZ,COMBOSAB,FUNDA1,PACK2QAT15AZ,PROYSOLO,QAT15AZ,SAB1',
    `entran los publicados o en proyecto, sin espacios, no los de sólo composición (${skus})`,
  );
  const venta = (sku: string) => indice.ventas.find((v) => v.sku === sku)!;
  afirmar(JSON.stringify(venta('PACK2QAT15AZ').origenes) === JSON.stringify([{ sku: 'QAT15AZ', unidades: 2 }]), 'origen del pack ×2, sin importar mayúsculas ni espacios');
  afirmar(venta('COMBOAZ').origenes.length === 2, 'el combo lleva dos orígenes');
  afirmar(venta('SAB1').origenes.length === 0, 'la fila alternativo no cuenta como origen');
  afirmar(JSON.stringify(venta('QAT15AZ').proyectos) === '["P1"]', 'dice en qué proyecto está');
  afirmar(venta('QAT15AZ').titulo === 'Quilt Atenas 1.5 Plazas Azul' && venta('SAB1').titulo === 'Sábana Polar Café', 'título: el primero que lo tiene');
  afirmar(venta('PROYSOLO').titulo === null && venta('PROYSOLO').origenes.length === 0, 'SKU sólo de proyecto: sin título ni origen');
  afirmar(JSON.stringify(Object.keys(indice.nombres).sort()) === '["FUNDA1","QAT15AZ","SAB2"]', 'nombres sólo de los orígenes usados');

  // --- Buscar ---
  const grupos = (q: string) =>
    buscarSkus(indice, tokens(q))
      .grupos.map((x) => `${x.origen}:${x.ventas.map((v) => v.sku).join('+')}`)
      .join(',');
  const proyectosDe = (q: string) => [...buscarSkus(indice, tokens(q)).proyectos].sort().join(',');

  const g = buscarSkus(indice, tokens('qat15az')).grupos;
  afirmar(g.length === 1 && g[0].origen === 'QAT15AZ' && g[0].nombre === 'Cubrecama Atenas 1.5 Azul', `por SKU origen: un grupo con su nombre (${g.map((x) => x.origen).join(',')})`);
  const filas = g[0].ventas.map((v) => `${v.sku}×${v.unidades}${v.combo ? ' combo' : ''}`).join(',');
  afirmar(
    filas === 'QAT15AZ×1,PACK2QAT15AZ×2,COMBOAZ×1 combo,COMBOSAB×1 combo',
    `todos los SKU venta que lo llevan: primero de a uno, después packs, al final combos (${filas})`,
  );
  afirmar(g[0].ventas.find((v) => v.sku === 'PACK2QAT15AZ')!.proyectos.length === 0, 'el pack sale sin proyecto');
  afirmar(proyectosDe('qat15az') === 'P1,P2', 'proyectos que tienen alguno de esos SKU');

  afirmar(grupos('atenas azul') === 'QAT15AZ:QAT15AZ+PACK2QAT15AZ+COMBOAZ+COMBOSAB', `por nombre: el combo no trae la funda (${grupos('atenas azul')})`);
  afirmar(grupos('quilt') === 'QAT15AZ:QAT15AZ+PACK2QAT15AZ+COMBOAZ+COMBOSAB', `por título de ML: los combos no traen la funda ni la sábana (${grupos('quilt')})`);
  afirmar(proyectosDe('atenas azul') === 'P1,P2', `ni abre el proyecto de la funda (${proyectosDe('atenas azul')})`);
  afirmar(grupos('sab2') === 'SAB2:COMBOSAB', `por SKU origen que ningún SKU venta contiene (${grupos('sab2')})`);
  afirmar(grupos('ALMOHÁDA') === 'FUNDA1:FUNDA1+COMBOAZ', `por nombre de origen, sin tildes ni mayúsculas (${grupos('ALMOHÁDA')})`);
  const combos = buscarSkus(indice, tokens('combo')).grupos.map((x) => x.origen).join(',');
  afirmar(combos === 'SAB2,QAT15AZ,FUNDA1', `buscar los combos trae todos sus orígenes, ordenados por nombre (${combos})`);
  afirmar(grupos('atenas cafe') === '', `todas las palabras en el mismo producto (${grupos('atenas cafe')})`);
  afirmar(grupos('polar cafe') === 'null:SAB1', `por título de ML; sin origen sale en su grupo (${grupos('polar cafe')})`);
  afirmar(proyectosDe('proysolo') === 'P3', 'SKU sólo de proyecto se encuentra');
  afirmar(grupos('noexiste') === '', 'sin coincidencias → nada');
  afirmar(buscarSkus(indice, []).grupos.length === 0, 'sin búsqueda → nada');

  const muchos: IndiceBusqueda = {
    ventas: [
      ...Array.from({ length: 25 }, (_, i) => ({ sku: `S${i}`, titulo: 'Toalla', origenes: [{ sku: `O${i}`, unidades: 1 }], proyectos: [`P${i}`] })),
      { sku: 'SINO', titulo: 'Toalla', origenes: [], proyectos: ['PX'] },
    ],
    nombres: {},
  };
  const tope = buscarSkus(muchos, tokens('toalla'), 20);
  afirmar(
    tope.grupos.length === 21 && tope.grupos[20].origen === null && tope.ocultos === 5 && tope.proyectos.size === 21,
    `tope de 20 SKU origen + el grupo sin origen; 5 ocultos; proyectos sólo de lo que se muestra (${tope.grupos.length}, ${tope.ocultos}, ${tope.proyectos.size})`,
  );
  afirmar(buscarSkus(muchos, tokens('toalla')).grupos.length === MAX_GRUPOS + 1, `tope por defecto ${MAX_GRUPOS}`);

  // --- Ruta ---
  // Base simulada: filtra, respeta `select` y corta en 1.000 filas. Sin `order`
  // las páginas no vienen en el mismo orden (PostgREST no lo garantiza): acá, la
  // segunda en adelante al revés, así una lectura sin orden pierde filas.
  const inventario: Record<string, Record<string, unknown>[]> = {
    ml_items_map: [
      { id: 1, item_id: 'MLC1', sku: 'QAT15AZ', sku_venta: 'QAT15AZ', titulo: 'Quilt Atenas 1.5 Plazas Azul', family_name: 'Quilt Atenas 1.5', thumbnail: null, permalink: null, bed_size: null, status_ml: 'active', catalog_listing: false, activo: true, variation_id: null },
    ],
    productos: [
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `p${String(i).padStart(5, '0')}`, sku: `RELL${i}`, nombre: 'Relleno', categoria: null, color: null, tamano: null })),
      { id: 'z-ultima', sku: 'QAT15AZ', nombre: 'Quilt Atenas 1.5 Azul', categoria: null, color: null, tamano: null },
    ],
    composicion_venta: [
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, sku_venta: `RELL${i}`, sku_origen: `RO${i}`, unidades: 1, tipo_relacion: 'componente' })),
      { id: 'z-alt', sku_venta: 'QAT15AZ', sku_origen: 'ALT1', unidades: 1, tipo_relacion: 'alternativo' },
      { id: 'z-ultima', sku_venta: 'PACK2QAT15AZ', sku_origen: 'QAT15AZ', unidades: 2, tipo_relacion: 'componente' },
    ],
  };
  const app: Record<string, Record<string, unknown>[]> = {
    projects: [{ id: 'P9', name: 'Pack Atenas', status: 'draft', created_at: null, metadata: { variantes: [{ sku: 'PACK2QAT15AZ' }] } }],
    swatches: [],
  };
  let caida: string | null = null;
  globalThis.fetch = (async (entrada: unknown) => {
    const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
    const tabla = url.pathname.replace('/rest/v1/', '');
    const base = url.host === 'inventario.test' ? inventario : url.host === 'app-db.test' ? app : null;
    if (!base || !(tabla in base)) return new Response('[]', { status: 404 });
    if (tabla === caida) return new Response(JSON.stringify({ message: 'caída simulada' }), { status: 500 });
    let filas = base[tabla];
    for (const [k, v] of url.searchParams) {
      if (v === 'eq.true') filas = filas.filter((f) => f[k] === true);
      else if (v === 'is.null') filas = filas.filter((f) => f[k] === null || f[k] === undefined);
      else if (v === 'not.is.null') filas = filas.filter((f) => f[k] !== null && f[k] !== undefined);
    }
    filas = [...filas].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const desde = Number(url.searchParams.get('offset') ?? 0);
    if (!url.searchParams.has('order') && desde > 0) filas.reverse();
    const cuantas = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000);
    const columnas = (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim());
    const pagina = filas
      .slice(desde, desde + cuantas)
      .map((f) => (columnas.includes('*') ? f : Object.fromEntries(columnas.map((c) => [c, f[c]]))));
    return new Response(JSON.stringify(pagina), { status: 200 });
  }) as typeof fetch;

  const ruta = await import('../src/app/api/projects/indice-busqueda/route');
  const res = await ruta.GET();
  const cuerpo = (await res.json()) as IndiceBusqueda;
  const pack = cuerpo.ventas?.find((v) => v.sku === 'PACK2QAT15AZ');
  afirmar(res.status === 200 && pack?.origenes[0]?.unidades === 2 && pack.proyectos[0] === 'P9', `ruta: lee composicion_venta pasada la fila 1.000 (${JSON.stringify(pack)})`);
  afirmar(cuerpo.nombres?.QAT15AZ === 'Quilt Atenas 1.5 Azul', 'ruta: nombre del origen, pasada la fila 1.000 de productos');
  const quilt = cuerpo.ventas?.find((v) => v.sku === 'QAT15AZ');
  afirmar(quilt?.origenes.length === 0, `ruta: la fila alternativo no cuenta (${JSON.stringify(quilt?.origenes)})`);

  caida = 'composicion_venta';
  afirmar((await ruta.GET()).status === 500, 'ruta: caída de la base → 500');
  caida = null;
  delete process.env.INVENTORY_SUPABASE_URL;
  afirmar((await ruta.GET()).status === 500, 'ruta: sin INVENTORY_* → 500');

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

export {};

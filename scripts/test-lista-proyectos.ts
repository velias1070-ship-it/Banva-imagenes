/**
 * Prueba de la lista de proyectos: buscador y orden por familia de bodega.
 *
 * Todo con datos SINTÉTICOS (el repo es público: ningún SKU, familia ni nombre
 * de proyecto real) y sin red. La base es un fetch simulado que, como la real,
 * entrega como máximo 1.000 filas por consulta aunque se pida más.
 *
 * - skusDeProyecto: metadata mala (null, texto, variantes que no son arreglo,
 *   sku que no es texto o vacío) no lanza; une variantes con los sufijos de
 *   swatches; sin duplicados aunque cambien las mayúsculas; orden numérico.
 * - familiasDe: null si bodega no se leyó, [] si se leyó y no hay familia, y
 *   ordenadas por cuántos SKU aporta cada una.
 * - ordenarPorFamilia: cada familia en un bloque contiguo; los sin familia al
 *   final; el resultado no depende del orden en que llegan.
 * - normalizar y coincide: sin tildes ni mayúsculas, SKU parcial, SKU que solo
 *   está en swatches, familia, tokens AND y una consulta que no existe.
 * - formatearFecha: 2026-09-29T02:30:00Z es 28-09-2026 en cualquier zona horaria
 *   del proceso; una fecha inválida da null.
 * - leerTodo + base con tope: 1.500 swatches llegan completos a su proyecto y un
 *   error en la 2ª página se propaga (no devuelve una lista a medias).
 * - getInventarioSupabase: sin variables de bodega lanza, no cae a la base propia.
 *
 * Lecturas del plan donde la firma admite dos (elegida la más natural):
 * - coincide(fila, q) recibe el texto TAL CUAL lo escribe la persona y lo
 *   normaliza él; una consulta vacía deja pasar todo.
 * - familiasDe recibe un Map sku (MAYÚSCULAS) → familia y compara en MAYÚSCULAS.
 * - Los SKU salen de skusDeProyecto en MAYÚSCULAS ("en mayúsculas", plan).
 * - ordenarPorFamilia devuelve el arreglo ordenado (se usa el retorno).
 *
 * Uso: npx tsx scripts/test-lista-proyectos.ts  (no llama a ninguna API)
 */
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import type { FilaProyecto } from '../src/lib/lista-proyectos';

process.env.INVENTORY_SUPABASE_URL = 'http://bodega-simulada.test';
process.env.INVENTORY_SUPABASE_KEY = 'clave-de-prueba';
// La base PROPIA de la app también está definida: si getInventarioSupabase
// cayera a ella cuando faltan las variables de bodega (el patrón `||` de otros
// archivos), la prueba lo vería. Sin estas dos líneas un fallback pasaba
// desapercibido porque igual lanzaba, por falta de variables.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://propia-simulada.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-de-prueba';

type Fila = Record<string, unknown>;

// --- Base simulada -----------------------------------------------------------
const TOPE_SERVIDOR = 1000;
const HOST_PROPIA = 'propia-simulada.test';
const HOST_BODEGA = 'bodega-simulada.test';

let contadorId = 0;
const nuevoId = () => `00000000-0000-0000-0000-${String(++contadorId).padStart(12, '0')}`;

const N_PROYECTOS = 1200;
const N_SWATCHES = 1500; // más que el tope de 1.000 por consulta
const N_PRODUCTOS = 2300;

// Los primeros 1.150 proyectos apuntan a un producto de bodega; el resto, a un
// SKU que bodega no conoce. Los SKU de metadata van en minúscula a propósito.
const proyectosDb: Fila[] = [];
for (let j = 0; j < N_PROYECTOS; j++) {
  proyectosDb.push({
    id: nuevoId(),
    name: `Proyecto sintetico ${j}`,
    category: 'otros',
    sku_base: `slug-sintetico-${j}`,
    status: 'draft',
    created_at: new Date(Date.UTC(2026, 0, 1) + j * 3_600_000).toISOString(),
    metadata: { variantes: [{ sku: j < 1150 ? `zqp${j * 2}` : `zqx${j}` }] },
  });
}
// 1.500 swatches repartidos entre los primeros 300 proyectos (5 cada uno).
const swatchesDb: Fila[] = [];
for (let i = 0; i < N_SWATCHES; i++) {
  swatchesDb.push({ id: nuevoId(), project_id: proyectosDb[i % 300].id, sku_suffix: `zqsw${i}` });
}
const productosDb: Fila[] = [];
for (let i = 0; i < N_PRODUCTOS; i++) {
  productosDb.push({ id: nuevoId(), sku: `ZQP${i}`, familia: `Linea ${String(i % 40).padStart(2, '0')}` });
}

const bases: Record<string, Record<string, Fila[]>> = {
  [HOST_PROPIA]: { projects: proyectosDb, swatches: swatchesDb },
  [HOST_BODEGA]: { productos: productosDb },
};
let fallo: { host: string; tabla: string; desdeOffset: number } | null = null;
const peticiones: string[] = [];

globalThis.fetch = (async (entrada: unknown) => {
  const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
  peticiones.push(`${url.host}${url.pathname}`);
  const tablas = bases[url.host];
  if (!tablas) throw new Error(`red no permitida en la prueba: ${url.host}`);
  const tabla = url.pathname.replace('/rest/v1/', '');
  if (!(tabla in tablas)) {
    return new Response(JSON.stringify({ message: `tabla inexistente: ${tabla}` }), { status: 404 });
  }
  const p = url.searchParams;
  const desde = Number(p.get('offset') ?? 0);
  if (fallo && fallo.host === url.host && fallo.tabla === tabla && desde >= fallo.desdeOffset) {
    return new Response(JSON.stringify({ message: 'caída simulada' }), { status: 500 });
  }
  for (const k of p.keys()) {
    if (!['select', 'order', 'offset', 'limit'].includes(k)) throw new Error(`filtro no simulado: ${k}`);
  }
  let filas = tablas[tabla];
  if (p.get('order')?.startsWith('id')) filas = [...filas].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cuantas = Math.min(Number(p.get('limit') ?? TOPE_SERVIDOR), TOPE_SERVIDOR);
  return new Response(JSON.stringify(filas.slice(desde, desde + cuantas)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

// --- Utilidades de la prueba ------------------------------------------------
let fallas = 0;
let oks = 0;
async function chequear(msg: string, fn: () => boolean | Promise<boolean>) {
  let cond = false;
  let extra = '';
  try {
    cond = await fn();
  } catch (e) {
    extra = ` [lanzó: ${e instanceof Error ? e.message : String(e)}]`;
  }
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}${cond ? '' : extra}`);
  if (cond) oks++;
  else fallas++;
}

const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Barajado determinista (sin azar): la prueba tiene que dar lo mismo cada vez.
function barajar<T>(arr: T[], semilla: number): T[] {
  const out = [...arr];
  let s = semilla;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Pares de tarjetas seguidas que comparten la primera familia.
function paresAdyacentes(filas: FilaProyecto[]): number {
  let n = 0;
  for (let i = 0; i + 1 < filas.length; i++) {
    const a = filas[i].familias?.[0];
    if (a && a === filas[i + 1].familias?.[0]) n++;
  }
  return n;
}

// Cada familia ocupa un solo tramo de posiciones consecutivas.
function bloquesContiguos(filas: FilaProyecto[]): boolean {
  const vistas = new Set<string>();
  let actual: string | null = null;
  for (const f of filas) {
    const fam = f.familias?.[0] ?? null;
    if (fam === actual) continue;
    if (fam !== null && vistas.has(fam)) return false;
    if (fam !== null) vistas.add(fam);
    actual = fam;
  }
  return true;
}

interface ProyectoSintetico {
  name: string;
  category: string;
  sku_base: string;
  metadata: unknown;
  sufijos: string[];
  created_at?: string;
}

const ISO_FECHA = '2026-09-29T02:30:00Z';

async function main() {
  const lp = await import('../src/lib/lista-proyectos');

  // Modo hijo: imprime la fecha nueva y la vieja (sin zona fija) en la zona horaria
  // con la que se lanzó el proceso. La zona se fija al arrancar: cambiar
  // process.env.TZ adentro de un proceso que ya formateó una fecha no alcanza,
  // porque Intl.DateTimeFormat toma la zona al crearse y la implementación la cachea.
  if (process.argv.includes('--solo-fecha')) {
    console.log(`${lp.formatearFecha(ISO_FECHA)}|${new Date(ISO_FECHA).toLocaleDateString('es-CL')}`);
    process.exit(0);
  }

  const { leerTodo } = await import('../src/lib/leer-todo');
  const { getInventarioSupabase } = await import('../src/lib/ml-client');

  // Arma una fila como lo hace la página: SKU = variantes ∪ swatches; familias
  // desde el mapa de bodega (o null si bodega no se leyó).
  function armarFila(p: ProyectoSintetico, mapa: Map<string, string> | null): FilaProyecto {
    const created_at = p.created_at ?? '2026-09-01T12:00:00Z';
    const skus = lp.skusDeProyecto(p.metadata, p.sufijos);
    return {
      id: nuevoId(),
      name: p.name,
      category: p.category,
      sku_base: p.sku_base,
      status: 'draft',
      created_at,
      fecha: lp.formatearFecha(created_at),
      skus,
      familias: lp.familiasDe(skus, mapa),
    };
  }
  const filaSimple = (name: string, skus: string[], familias: string[] | null): FilaProyecto => ({
    id: nuevoId(),
    name,
    category: 'otros',
    sku_base: 'slug-sintetico',
    status: 'draft',
    created_at: '2026-09-01T12:00:00Z',
    fecha: '01-09-2026',
    skus,
    familias,
  });

  // ===== skusDeProyecto ======================================================
  const basura: unknown[] = [null, undefined, 'texto', 42, true, [], {}, { variantes: null }, { variantes: 'abc' }, { variantes: 7 }, { variantes: { sku: 'ZQX1' } }];
  for (const m of basura) {
    await chequear(`skusDeProyecto: metadata ${JSON.stringify(m) ?? 'undefined'} no lanza y da []`, () => igual(lp.skusDeProyecto(m, []), []));
  }
  await chequear('skusDeProyecto: metadata que no es objeto igual usa los sufijos', () => igual(lp.skusDeProyecto('texto', ['zqa1']), ['ZQA1']));
  await chequear('skusDeProyecto: variantes con basura adentro (null, número, texto, sku no texto, vacío, sin sku)', () =>
    igual(lp.skusDeProyecto({ variantes: [null, undefined, 7, 'texto', [], { sku: 42 }, { sku: null }, { sku: '' }, { sku: '   ' }, {}, { sku: 'zqok1' }] }, []), ['ZQOK1']),
  );
  await chequear('skusDeProyecto: los SKU salen en MAYÚSCULAS y sin espacios', () => igual(lp.skusDeProyecto({ variantes: [{ sku: '  zqb2  ' }] }, []), ['ZQB2']));
  await chequear('skusDeProyecto: une variantes con los sufijos de swatches', () =>
    igual(lp.skusDeProyecto({ variantes: [{ sku: 'zqa1' }] }, ['ZQB1']), ['ZQA1', 'ZQB1']),
  );
  await chequear('skusDeProyecto: sin metadata.variantes, solo con sufijos, igual da SKU', () => igual(lp.skusDeProyecto({ variantes: [] }, ['zqs9']), ['ZQS9']));
  await chequear('skusDeProyecto: sin duplicados aunque cambien mayúsculas y espacios', () => {
    const r = lp.skusDeProyecto({ variantes: [{ sku: 'zqa1' }, { sku: 'ZQA1' }, { sku: ' Zqa1 ' }] }, ['zqA1', 'ZQA1']);
    return r.length === 1 && r[0].toUpperCase() === 'ZQA1';
  });
  await chequear('skusDeProyecto: orden numérico (ZQ1, ZQ2, ZQ10 y no ZQ1, ZQ10, ZQ2)', () =>
    igual(lp.skusDeProyecto({ variantes: [{ sku: 'ZQ10' }, { sku: 'ZQ2' }, { sku: 'ZQ1' }] }, []).map((s) => s.toUpperCase()), ['ZQ1', 'ZQ2', 'ZQ10']),
  );
  await chequear('skusDeProyecto: un sufijo vacío no produce un SKU vacío', () => igual(lp.skusDeProyecto(null, ['', '  ', 'zqe5']), ['ZQE5']));
  await chequear('skusDeProyecto: no modifica el arreglo de sufijos que recibe', () => {
    const suf = ['ZQ9', 'ZQ1'];
    lp.skusDeProyecto({ variantes: [{ sku: 'ZQ5' }] }, suf);
    return igual(suf, ['ZQ9', 'ZQ1']);
  });

  // ===== familiasDe ==========================================================
  const MAPA = new Map<string, string>([
    ['ZQA100C', 'Linea Aurora'],
    ['ZQA100D', 'Linea Aurora'],
    ['ZQT200N', 'Linea Boreal'],
    ['ZQT200B', 'Linea Boreal'],
    ['ZQT200C', 'Linea Cenit'],
    ['ZQC400', 'Línea Ñandú'],
  ]);
  await chequear('familiasDe: bodega no leída (mapa null) → null, no []', () => lp.familiasDe(['ZQA100C'], null) === null);
  await chequear('familiasDe: bodega no leída y proyecto sin SKU → null', () => lp.familiasDe([], null) === null);
  await chequear('familiasDe: bodega leída pero el SKU no está → [] (arreglo vacío)', () => {
    const r = lp.familiasDe(['ZQNOEXISTE'], MAPA);
    return Array.isArray(r) && r.length === 0;
  });
  await chequear('familiasDe: bodega leída y proyecto sin SKU → []', () => {
    const r = lp.familiasDe([], MAPA);
    return Array.isArray(r) && r.length === 0;
  });
  await chequear('familiasDe: dos SKU de la misma familia dan la familia una sola vez', () => igual(lp.familiasDe(['ZQA100C', 'ZQA100D'], MAPA), ['Linea Aurora']));
  await chequear('familiasDe: ordena por cuántos SKU aporta cada familia (Boreal 2, Cenit 1)', () =>
    igual(lp.familiasDe(['ZQT200C', 'ZQT200N', 'ZQT200B'], MAPA), ['Linea Boreal', 'Linea Cenit']),
  );
  const MAPA_FRECUENCIA = new Map<string, string>([
    ['ZQF1', 'Zeta Linea'],
    ['ZQF2', 'Zeta Linea'],
    ['ZQF3', 'Zeta Linea'],
    ['ZQF4', 'Beta Linea'],
    ['ZQF5', 'Alfa Linea'],
  ]);
  await chequear('familiasDe: la más frecuente primero aunque sea la última en alfabeto; empate por alfabeto', () =>
    igual(lp.familiasDe(['ZQF5', 'ZQF4', 'ZQF3', 'ZQF2', 'ZQF1'], MAPA_FRECUENCIA), ['Zeta Linea', 'Alfa Linea', 'Beta Linea']),
  );
  await chequear('familiasDe: compara el SKU en MAYÚSCULAS (llega en minúscula y la encuentra)', () => igual(lp.familiasDe(['zqa100c'], MAPA), ['Linea Aurora']));
  await chequear('familiasDe: una familia vacía en bodega no cuenta como familia', () => {
    const r = lp.familiasDe(['ZQV1'], new Map<string, string>([['ZQV1', '']]));
    return Array.isArray(r) && r.length === 0;
  });

  // ===== ordenarPorFamilia ===================================================
  const orden = [
    filaSimple('Zeta uno', ['ZQ-Z1'], ['Línea Zeta']),
    filaSimple('Ovalo uno', ['ZQ-O5'], ['Línea Óvalo']),
    filaSimple('Aurora cien', ['ZQ-A100'], ['Línea Aurora']),
    filaSimple('Aurora veinte B', ['ZQ-A20'], ['Línea Aurora']),
    filaSimple('Aurora veinte A', ['ZQ-A20'], ['Línea Aurora']),
    filaSimple('Mixto', ['ZQ-M1', 'ZQ-Z1'], ['Línea Zeta', 'Línea Aurora']),
    filaSimple('Sin familia con SKU', ['ZQ-X9'], []),
    filaSimple('Sin familia sin SKU B', [], []),
    filaSimple('Sin familia sin SKU A', [], []),
  ];
  const nombres = (filas: FilaProyecto[]) => filas.map((f) => f.name);
  const ESPERADO_ORDEN = [
    'Aurora veinte A', // familia Aurora, SKU ZQ-A20 (numérico: antes que A100), empate por nombre
    'Aurora veinte B',
    'Aurora cien', // ZQ-A100
    'Ovalo uno', // Óvalo va antes que Zeta: se ordena con Collator, no por código de letra
    'Mixto', // primera familia = Zeta; su menor SKU ZQ-M1 va antes que ZQ-Z1
    'Zeta uno',
    'Sin familia con SKU', // los sin familia al final; con SKU antes que sin SKU
    'Sin familia sin SKU A',
    'Sin familia sin SKU B',
  ];
  await chequear('ordenarPorFamilia: familia (Collator), menor SKU (numérico), nombre; sin familia al final', () =>
    igual(nombres(lp.ordenarPorFamilia(orden)), ESPERADO_ORDEN),
  );
  await chequear('ordenarPorFamilia: no depende del orden en que llegan (invertido y barajado)', () =>
    igual(nombres(lp.ordenarPorFamilia([...orden].reverse())), ESPERADO_ORDEN) && igual(nombres(lp.ordenarPorFamilia(barajar(orden, 7))), ESPERADO_ORDEN),
  );
  await chequear('ordenarPorFamilia: cada familia queda en un bloque contiguo', () => bloquesContiguos(lp.ordenarPorFamilia(orden)));
  await chequear('ordenarPorFamilia: idempotente (ordenar dos veces da lo mismo)', () =>
    igual(nombres(lp.ordenarPorFamilia(lp.ordenarPorFamilia(orden))), ESPERADO_ORDEN),
  );
  const sinBodega = orden.map((f) => ({ ...f, familias: null }));
  await chequear('ordenarPorFamilia: con familias null (bodega no leída) cae al menor SKU y los sin SKU al final', () =>
    igual(nombres(lp.ordenarPorFamilia(sinBodega)), [
      'Aurora veinte A',
      'Aurora veinte B',
      'Aurora cien',
      'Mixto',
      'Ovalo uno',
      'Sin familia con SKU',
      'Zeta uno',
      'Sin familia sin SKU A',
      'Sin familia sin SKU B',
    ]),
  );
  await chequear('ordenarPorFamilia: null y [] van los dos después de todas las que tienen familia', () => {
    const mezcla = [filaSimple('N1', ['ZQ-1'], null), filaSimple('E1', ['ZQ-2'], []), filaSimple('F1', ['ZQ-9'], ['Línea Zeta']), filaSimple('F2', ['ZQ-8'], ['Línea Aurora'])];
    const r = nombres(lp.ordenarPorFamilia(mezcla));
    return igual(r.slice(0, 2), ['F2', 'F1']) && new Set(r.slice(2)).size === 2 && r.slice(2).every((n) => n === 'N1' || n === 'E1');
  });
  await chequear('ordenarPorFamilia: lista vacía → []', () => lp.ordenarPorFamilia([]).length === 0);

  // Población grande: 40 familias × 5 proyectos y 30 sin familia, barajados.
  const grande: FilaProyecto[] = [];
  let k = 0;
  for (let f = 0; f < 40; f++) {
    for (let i = 0; i < 5; i++) grande.push(filaSimple(`Proyecto ${String(k).padStart(4, '0')}`, [`ZQL${k++}`], [`Línea ${String(f).padStart(2, '0')}`]));
  }
  for (let i = 0; i < 30; i++) grande.push(filaSimple(`Proyecto ${String(k).padStart(4, '0')}`, [`ZQL${k++}`], []));
  const revueltas = barajar(grande, 42);
  const ordenadas = lp.ordenarPorFamilia(revueltas);
  const MAX_PARES = 40 * 4;
  await chequear(`ordenarPorFamilia (control del instrumento): revueltas dan pocos pares seguidos de la misma familia (${paresAdyacentes(revueltas)} de ${MAX_PARES})`, () => paresAdyacentes(revueltas) < MAX_PARES / 4);
  await chequear(`ordenarPorFamilia: ordenadas dan ${MAX_PARES} de ${MAX_PARES} pares seguidos posibles (${paresAdyacentes(ordenadas)})`, () => paresAdyacentes(ordenadas) === MAX_PARES);
  await chequear('ordenarPorFamilia: 230 filas → bloques contiguos, sin familia al final y ninguna se pierde', () =>
    ordenadas.length === 230 && bloquesContiguos(ordenadas) && ordenadas.slice(-30).every((f) => f.familias?.length === 0) && new Set(ordenadas.map((f) => f.id)).size === 230,
  );
  await chequear('ordenarPorFamilia: dos barajados distintos dan el mismo orden', () =>
    igual(nombres(lp.ordenarPorFamilia(barajar(grande, 1))), nombres(lp.ordenarPorFamilia(barajar(grande, 2)))),
  );

  // ===== normalizar ==========================================================
  await chequear('normalizar: minúsculas, sin tildes ni la eñe («ÁRBOL Ñandú Sábanas» → «arbol nandu sabanas»)', () => lp.normalizar('ÁRBOL Ñandú Sábanas') === 'arbol nandu sabanas');
  await chequear('normalizar: deja intactos los guiones y dígitos de un SKU («ZQ-A100» → «zq-a100»)', () => lp.normalizar('ZQ-A100') === 'zq-a100');

  // ===== coincide (buscador) =================================================
  const PROYECTOS: ProyectoSintetico[] = [
    { name: 'Quilt Aurora Norte', category: 'quilts', sku_base: 'quilt-aurora-norte', metadata: { variantes: [{ sku: 'zqa100c' }, { sku: 'ZQA100D' }] }, sufijos: [] },
    { name: 'Toalla Boreal', category: 'toallas', sku_base: 'toalla-boreal', metadata: { variantes: [{ sku: 'ZQT200N' }] }, sufijos: ['ZQT200B', 'zqt200c'] },
    { name: 'Sábana Ñandú Niño', category: 'sabanas', sku_base: 'sabana-nandu-nino', metadata: { variantes: [] }, sufijos: ['ZQS300X'] },
    { name: 'Proyecto vacío', category: 'otros', sku_base: 'slug-sin-nada', metadata: null, sufijos: [] },
    { name: 'Cortina Simple', category: 'cortinas', sku_base: 'cortina-simple', metadata: { variantes: [{ sku: 'ZQC400' }] }, sufijos: [] },
  ];
  const conBodega = PROYECTOS.map((p) => armarFila(p, MAPA));
  const bodegaSinMatch = PROYECTOS.map((p) => armarFila(p, new Map<string, string>()));
  const bodegaNoLeida = PROYECTOS.map((p) => armarFila(p, null));
  const buscar = (filas: FilaProyecto[], q: string) => filas.filter((f) => lp.coincide(f, q)).map((f) => f.name).sort();
  const esperar = (...n: string[]) => [...n].sort();
  const P1 = 'Quilt Aurora Norte';
  const P2 = 'Toalla Boreal';
  const P3 = 'Sábana Ñandú Niño';
  const P4 = 'Proyecto vacío';
  const P5 = 'Cortina Simple';

  // C1: SKU de variante, sin importar mayúsculas.
  await chequear('coincide: SKU de una variante (mayúscula) encuentra su proyecto', () => igual(buscar(conBodega, 'ZQA100C'), esperar(P1)));
  await chequear('coincide: el mismo SKU en minúscula encuentra lo mismo', () => igual(buscar(conBodega, 'zqa100c'), esperar(P1)));
  await chequear('coincide: SKU parcial («zqa100» y «a100c»)', () => igual(buscar(conBodega, 'zqa100'), esperar(P1)) && igual(buscar(conBodega, 'a100c'), esperar(P1)));
  await chequear('coincide: SKU de otra variante del mismo proyecto', () => igual(buscar(conBodega, 'ZQC400'), esperar(P5)));
  // C2: SKU que solo está en swatches.
  await chequear('coincide: SKU presente solo en los sufijos de swatches encuentra su proyecto', () => igual(buscar(conBodega, 'ZQS300X'), esperar(P3)));
  await chequear('coincide: sufijo de swatch de un proyecto que además tiene variantes (en minúscula)', () => igual(buscar(conBodega, 'zqt200b'), esperar(P2)));
  // Sin tildes ni mayúsculas.
  await chequear('coincide: sin tildes en la consulta, con tilde en el dato («sabana nandu nino»)', () => igual(buscar(conBodega, 'sabana nandu nino'), esperar(P3)));
  await chequear('coincide: con tildes y mayúsculas en la consulta («SÁBANA ÑANDÚ»)', () => igual(buscar(conBodega, 'SÁBANA ÑANDÚ'), esperar(P3)));
  await chequear('coincide: tilde en la consulta y ninguna en el dato («cortína»)', () => igual(buscar(conBodega, 'cortína'), esperar(P5)));
  await chequear('coincide: «VACÍO» encuentra «Proyecto vacío» y también «vacio»', () => igual(buscar(conBodega, 'VACÍO'), esperar(P4)) && igual(buscar(conBodega, 'vacio'), esperar(P4)));
  // Campos: name, sku_base, category.
  await chequear('coincide: por nombre', () => igual(buscar(conBodega, 'quilt'), esperar(P1)));
  await chequear('coincide: por categoría («CORTINAS»)', () => igual(buscar(conBodega, 'CORTINAS'), esperar(P5)));
  await chequear('coincide: por sku_base (slug), que ya no se muestra pero sigue buscable', () => igual(buscar(conBodega, 'slug-sin-nada'), esperar(P4)));
  // C3: familia.
  await chequear('coincide: por familia de bodega que el nombre no tiene («linea cenit» → Toalla Boreal)', () => igual(buscar(conBodega, 'linea cenit'), esperar(P2)));
  await chequear('coincide: por familia («LINEA AURORA»)', () => igual(buscar(conBodega, 'LINEA AURORA'), esperar(P1)));
  await chequear('coincide: familia con tilde y eñe («línea ÑANDÚ» → solo la Cortina; la Sábana tiene «ñandú» pero no «línea»)', () => igual(buscar(conBodega, 'línea ÑANDÚ'), esperar(P5)));
  await chequear('coincide (control): sin familia (bodega no leída) las mismas búsquedas dan 0', () => buscar(bodegaNoLeida, 'linea cenit').length === 0 && buscar(bodegaNoLeida, 'línea ÑANDÚ').length === 0);
  await chequear('coincide (control): con bodega leída pero sin familia para esos SKU también dan 0', () => buscar(bodegaSinMatch, 'linea cenit').length === 0 && buscar(bodegaSinMatch, 'línea ÑANDÚ').length === 0);
  await chequear('coincide (control): «ñandú» a secas da 2 con familia (Sábana y Cortina) y 1 sin ella', () => igual(buscar(conBodega, 'nandu'), esperar(P3, P5)) && igual(buscar(bodegaNoLeida, 'nandu'), esperar(P3)));
  // Tokens AND.
  await chequear('coincide: tokens AND de campos distintos (nombre + SKU) → 1', () => igual(buscar(conBodega, 'quilt zqa100c'), esperar(P1)));
  await chequear('coincide: tokens AND que no comparten proyecto («quilt zqt200b») → 0, no la unión', () => buscar(conBodega, 'quilt zqt200b').length === 0);
  await chequear('coincide: tokens AND nombre + familia («toalla cenit»)', () => igual(buscar(conBodega, 'toalla cenit'), esperar(P2)));
  await chequear('coincide: tokens AND categoría + nombre («sabanas nandu»)', () => igual(buscar(conBodega, 'sabanas nandu'), esperar(P3)));
  await chequear('coincide: espacios de más entre tokens y al borde', () => igual(buscar(conBodega, '  quilt    zqa100c  '), esperar(P1)));
  await chequear('coincide: un token no cruza el borde entre dos campos («nortequilt» no existe)', () => buscar(conBodega, 'nortequilt').length === 0 && igual(buscar(conBodega, 'norte'), esperar(P1)));
  // Consulta inexistente y consulta vacía.
  await chequear('coincide: consulta inexistente da 0 (control: «quilt» sí da 1 en la misma población)', () => buscar(conBodega, 'zzqxv-no-existe-987').length === 0 && buscar(conBodega, 'quilt').length === 1);
  await chequear('coincide: consulta vacía o de espacios deja pasar a todos', () => buscar(conBodega, '').length === 5 && buscar(conBodega, '   ').length === 5);
  await chequear('coincide: caracteres especiales de regex no lanzan y no encuentran nada', () => ['(', '[', '\\', '*', '+', '?', '.*', '$'].every((q) => buscar(conBodega, q).length === 0));
  await chequear('coincide: una fila sin SKU y con familias null (bodega no leída) no revienta', () => lp.coincide(bodegaNoLeida[3], 'zzqxv') === false && lp.coincide(bodegaNoLeida[3], 'vacio') === true);

  // ===== formatearFecha ======================================================
  // Un proceso hijo por zona horaria: la zona se fija ANTES de que arranque.
  const enZona = (tz: string) => {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--solo-fecha'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    const [nuevo, viejo] = r.stdout.trim().split('|');
    return { rc: r.status, nuevo, viejo };
  };
  await chequear('formatearFecha (control): el formato viejo SÍ depende de la zona (UTC → 29-09-2026, Santiago → 28-09-2026)', () => enZona('UTC').viejo === '29-09-2026' && enZona('America/Santiago').viejo === '28-09-2026');
  for (const tz of ['UTC', 'America/Santiago', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    await chequear(`formatearFecha: ${ISO_FECHA} → 28-09-2026 con TZ=${tz}`, () => {
      const r = enZona(tz);
      return r.rc === 0 && r.nuevo === '28-09-2026';
    });
  }
  await chequear('formatearFecha: invierno usa el desfase de Chile (03:30Z de junio → 14-06-2026)', () => lp.formatearFecha('2026-06-15T03:30:00Z') === '14-06-2026');
  await chequear('formatearFecha: formato real de la base (microsegundos y +00:00)', () => lp.formatearFecha('2026-09-29T02:30:00.123456+00:00') === '28-09-2026');
  await chequear('formatearFecha: fecha inválida → null (no «Invalid Date» ni 1970)', () => lp.formatearFecha('no es una fecha') === null && lp.formatearFecha('') === null && lp.formatearFecha('2026-13-45T99:99:99Z') === null);

  // ===== getInventarioSupabase (paso 2) =====================================
  const url = process.env.INVENTORY_SUPABASE_URL;
  const clave = process.env.INVENTORY_SUPABASE_KEY;
  const lanza = (): boolean => {
    try {
      getInventarioSupabase();
      return false;
    } catch {
      return true;
    }
  };
  delete process.env.INVENTORY_SUPABASE_URL;
  await chequear('getInventarioSupabase: sin INVENTORY_SUPABASE_URL lanza (no cae a otra base)', lanza);
  process.env.INVENTORY_SUPABASE_URL = url;
  delete process.env.INVENTORY_SUPABASE_KEY;
  await chequear('getInventarioSupabase: sin INVENTORY_SUPABASE_KEY lanza', lanza);
  process.env.INVENTORY_SUPABASE_KEY = clave;
  await chequear('getInventarioSupabase: con las dos variables devuelve un cliente con .from', () => typeof getInventarioSupabase().from === 'function');

  // ===== leerTodo con el tope de 1.000 =======================================
  const paginaFalsa = (total: number, registro: Array<[number, number]> = []) => {
    const datos = Array.from({ length: total }, (_, i) => ({ i }));
    return async (desde: number, hasta: number) => {
      registro.push([desde, hasta]);
      if (registro.length > 20) throw new Error('leerTodo no termina');
      const cuantas = Math.min(hasta - desde + 1, TOPE_SERVIDOR);
      return { data: datos.slice(desde, desde + cuantas), error: null };
    };
  };
  for (const total of [0, 1, 999, 1000, 1001, 1500, 2000, 2500]) {
    await chequear(`leerTodo: ${total} filas con tope de 1.000 por consulta → llegan las ${total}, sin repetir`, async () => {
      const filas = await leerTodo(paginaFalsa(total));
      return filas.length === total && filas.every((f, i) => f.i === i);
    });
  }
  await chequear('leerTodo: error en la 1ª página → rechaza con el mensaje', async () => {
    try {
      await leerTodo(async () => ({ data: null, error: { message: 'caída simulada 1' } }));
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes('caída simulada 1');
    }
  });
  await chequear('leerTodo: error en la 2ª página → rechaza (no devuelve las 1.000 primeras como si fueran todas)', async () => {
    const ok = paginaFalsa(2500);
    try {
      await leerTodo(async (desde: number, hasta: number) => (desde >= 1000 ? { data: null, error: { message: 'caída simulada 2' } } : ok(desde, hasta)));
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes('caída simulada 2');
    }
  });

  // ===== De punta a punta contra la base simulada (tope 1.000) ===============
  // OJO: el armado de filas de acá (mapa de familias + FilaProyecto) REPLICA lo que
  // hace page.tsx con la misma forma; no lo importa porque page.tsx es un Server
  // Component que usa cookies. Si cambia allá hay que cambiarlo acá. Esto prueba la
  // lectura por páginas y las funciones de lista-proyectos.ts, NO page.tsx.
  const propia = createClient(`http://${HOST_PROPIA}`, 'clave-propia');
  const bodega = getInventarioSupabase();
  const leerProyectos = () =>
    leerTodo<Fila>((d, h) => propia.from('projects').select('id, name, category, sku_base, status, created_at, metadata').order('id').range(d, h));
  const leerSwatches = () => leerTodo<{ project_id: string; sku_suffix: string }>((d, h) => propia.from('swatches').select('project_id, sku_suffix').order('id').range(d, h));
  const leerProductos = () => leerTodo<{ sku: string; familia: string | null }>((d, h) => bodega.from('productos').select('sku, familia').order('id').range(d, h));

  const proyectos = await leerProyectos();
  const swatches = await leerSwatches();
  const productos = await leerProductos();
  await chequear(`base con tope: se leen los ${N_PROYECTOS} proyectos (${proyectos.length}), sin ids repetidos`, () => proyectos.length === N_PROYECTOS && new Set(proyectos.map((p) => p.id)).size === N_PROYECTOS);
  await chequear(`base con tope: se leen los ${N_SWATCHES} swatches (${swatches.length}), más de las 1.000 que entrega una consulta`, () => swatches.length === N_SWATCHES);
  await chequear(`base con tope: se leen los ${N_PRODUCTOS} productos (${productos.length})`, () => productos.length === N_PRODUCTOS);
  await chequear('base con tope: hubo más de una consulta por tabla (el tope obligó a paginar)', () => peticiones.filter((p) => p === `${HOST_PROPIA}/rest/v1/swatches`).length >= 2);

  const sufijosPorProyecto = new Map<string, string[]>();
  for (const s of swatches) sufijosPorProyecto.set(s.project_id, [...(sufijosPorProyecto.get(s.project_id) ?? []), s.sku_suffix]);
  const mapaBodega = new Map<string, string>();
  for (const p of productos) {
    const sku = (p.sku ?? '').trim().toUpperCase();
    const familia = (p.familia ?? '').trim();
    if (sku && familia) mapaBodega.set(sku, familia);
  }

  const filasTodas: FilaProyecto[] = proyectos.map((p) => {
    const created_at = String(p.created_at);
    const skus = lp.skusDeProyecto(p.metadata, sufijosPorProyecto.get(String(p.id)) ?? []);
    return {
      id: String(p.id),
      name: String(p.name),
      category: String(p.category),
      sku_base: String(p.sku_base),
      status: String(p.status),
      created_at,
      fecha: lp.formatearFecha(created_at),
      skus,
      familias: lp.familiasDe(skus, mapaBodega),
    };
  });
  const porId = new Map(filasTodas.map((f) => [f.id, f]));
  let sinLlegar = 0;
  for (const s of swatches) if (!porId.get(s.project_id)?.skus.includes(s.sku_suffix.toUpperCase())) sinLlegar++;
  await chequear(`swatches (1.500, más que el tope): todos llegan a su proyecto (sin llegar: ${sinLlegar})`, () => sinLlegar === 0);
  await chequear('swatch ubicado después de la fila 1.000 (zqsw1499) encuentra a su proyecto y solo a ese', () => {
    const halladas = filasTodas.filter((f) => lp.coincide(f, 'ZQSW1499'));
    return halladas.length === 1 && halladas[0].id === String(proyectos[1499 % 300].id);
  });
  await chequear('familia de un producto después de la fila 1.000 (ZQP2250 → Linea 10) llega al proyecto que lo usa', () => {
    const f = porId.get(String(proyectos[1125].id));
    return !!f && f.skus.includes('ZQP2250') && igual(f.familias, ['Linea 10']);
  });
  await chequear('proyectos con un SKU que bodega no conoce → familias [] (no null: bodega sí se leyó)', () => {
    const f = porId.get(String(proyectos[1199].id));
    return !!f && Array.isArray(f.familias) && f.familias.length === 0;
  });
  const ordenTodas = lp.ordenarPorFamilia(filasTodas);
  await chequear('lista completa ordenada: mismas filas, bloques contiguos, con familia primero', () => {
    const conFamilia = ordenTodas.findIndex((f) => f.familias?.length === 0);
    return ordenTodas.length === N_PROYECTOS && new Set(ordenTodas.map((f) => f.id)).size === N_PROYECTOS && bloquesContiguos(ordenTodas) && conFamilia === 1150 && ordenTodas.slice(1150).every((f) => f.familias?.length === 0);
  });
  await chequear('sin bodega (familias null) la lista completa sale ordenada por su menor SKU, sin perder filas', () => {
    const sin = lp.ordenarPorFamilia(filasTodas.map((f) => ({ ...f, familias: null })));
    const cmp = new Intl.Collator('es', { numeric: true });
    let ordenada = true;
    for (let i = 0; i + 1 < sin.length; i++) if (cmp.compare(sin[i].skus[0], sin[i + 1].skus[0]) > 0) ordenada = false;
    return sin.length === N_PROYECTOS && new Set(sin.map((f) => f.id)).size === N_PROYECTOS && sin.every((f) => f.familias === null) && ordenada;
  });

  // Errores de lectura: se propagan (la página muestra la tarjeta de error).
  fallo = { host: HOST_PROPIA, tabla: 'swatches', desdeOffset: 1000 };
  await chequear('error de la base en la 2ª página de swatches → la lectura rechaza (no una lista a medias)', async () => {
    try {
      await leerSwatches();
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes('caída simulada');
    }
  });
  fallo = { host: HOST_BODEGA, tabla: 'productos', desdeOffset: 0 };
  await chequear('error de la base de bodega → la lectura rechaza (la página lo degrada a «no disponible»)', async () => {
    try {
      await leerProductos();
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes('caída simulada');
    }
  });
  fallo = null;
  await chequear('nunca se pidió nada fuera de las dos bases simuladas', () => peticiones.every((p) => p.startsWith(HOST_PROPIA) || p.startsWith(HOST_BODEGA)));

  console.log(fallas === 0 ? `\nTodo bien (${oks} ok).` : `\n${fallas} falla(s), ${oks} ok.`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

// Módulo propio: sin esto sus nombres chocan con los de los otros scripts de prueba.
export {};

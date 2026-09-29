/**
 * Prueba de GET /api/productos contra una base simulada que, como la real,
 * entrega como máximo 1.000 filas por consulta aunque se pida más.
 *
 * - La lista viene COMPLETA: la familia de limpiapiés está después de la fila
 *   1.000 (antes se perdía).
 * - Solo tradicionales, activas y pausadas: la de catálogo y la cerrada no entran.
 * - Productos sueltos (una sola publicación) aparecen.
 * - Un sku_venta con dos avisos va una vez, con el activo.
 * - La categoría sale de la palabra del nombre sin tildes, de la categoría de
 *   Bodega si calza con una de la app, o '' (el formulario obliga a elegirla).
 * - Dos familias con el mismo nombre no comparten slug.
 * - ?sku= devuelve ese SKU solo, con un slug distinto al de su familia.
 * - Un error de la base no se traga: la ruta responde 500.
 *
 * Uso: npx tsx scripts/test-lista-productos.ts  (no llama a ninguna API)
 */
process.env.INVENTORY_SUPABASE_URL = 'http://base-simulada.test';
process.env.INVENTORY_SUPABASE_KEY = 'clave-de-prueba';

type Fila = Record<string, unknown>;

const TOPE_SERVIDOR = 1000;
let id = 0;
const nuevoId = () => `00000000-0000-0000-0000-${String(++id).padStart(12, '0')}`;

function aviso(p: Partial<Fila> & { item_id: string; sku_venta: string; titulo: string }): Fila {
  return {
    id: nuevoId(),
    sku: p.sku_venta,
    family_name: null,
    thumbnail: null,
    permalink: null,
    bed_size: null,
    status_ml: 'active',
    catalog_listing: false,
    activo: true,
    variation_id: null,
    ...p,
  };
}

const mlItems: Fila[] = [];
// 1.200 avisos de relleno, de a pares por familia.
for (let i = 0; i < 1200; i++) {
  mlItems.push(
    aviso({
      item_id: `MLC9${String(i).padStart(8, '0')}`,
      sku_venta: `RELLENO${i}`,
      titulo: `Relleno ${Math.floor(i / 2)} Color${i % 2}`,
      family_name: `Relleno Familia ${Math.floor(i / 2)}`,
    }),
  );
}
const LP = 'Alfombra Limpia Pies Exterior Choapino Fibra De Coco';
mlItems.push(
  aviso({ item_id: 'MLC2250580065', sku_venta: 'ALPCMPRFK4060', titulo: `${LP} Flores`, family_name: LP }),
  aviso({ item_id: 'MLC2250580075', sku_venta: 'ALPCMPRHR4060', titulo: `${LP} Hojas`, family_name: LP, status_ml: 'paused' }),
  aviso({ item_id: 'MLC2250580099', sku_venta: 'ALPCMPRCT4060', titulo: `${LP} Gato`, family_name: LP, catalog_listing: true }),
  aviso({ item_id: 'MLC2250580100', sku_venta: 'ALPCMPRPZ4060', titulo: `${LP} Paz`, family_name: LP, status_ml: 'closed' }),
  // mismo sku_venta, primero el pausado y después el activo
  aviso({ item_id: 'MLC2250580200', sku_venta: 'ALPCMPRSL4060', titulo: `${LP} Sol`, family_name: LP, status_ml: 'paused' }),
  aviso({ item_id: 'MLC2250580201', sku_venta: 'ALPCMPRSL4060', titulo: `${LP} Sol`, family_name: LP }),
  // sin clasificar todavía (catalog_listing y status_ml NULL): entra
  aviso({ item_id: 'MLC2250580300', sku_venta: 'ALPCMPRLN4060', titulo: `${LP} Luna`, family_name: LP, catalog_listing: null, status_ml: null }),
  // fuera por la consulta: activo=false y fila de variación
  aviso({ item_id: 'MLC2250580400', sku_venta: 'ALPCMPRXX4060', titulo: `${LP} Viejo`, family_name: LP, activo: false }),
  aviso({ item_id: 'MLC2250580500', sku_venta: 'ALPCMPRVV4060', titulo: `${LP} Var`, family_name: LP, variation_id: 123 }),
  // producto suelto, sin palabra conocida
  aviso({ item_id: 'MLC4509242906', sku_venta: '115799386112', titulo: 'Cama Perro Gato Mascota Grande Lavable L' }),
  // sábanas con tilde
  aviso({ item_id: 'MLC1000000001', sku_venta: 'SAB1', titulo: 'Juego De Sábanas Polar 2 Plazas Azul', family_name: 'Juego De Sábanas Polar 2 Plazas' }),
  // alfombra que es limpiapiés por el nombre
  aviso({ item_id: 'MLC1000000002', sku_venta: 'LP2', titulo: 'Alfombra Limpiapies Goma Negro', family_name: 'Alfombra Limpiapies Goma' }),
  // dos familias distintas con el mismo nombre visible
  aviso({ item_id: 'MLC1000000003', sku_venta: 'TH1', titulo: 'Toalla Hotel Blanca', family_name: 'Toalla Hotel' }),
  aviso({ item_id: 'MLC1000000004', sku_venta: 'TH2', titulo: 'Toalla Hotel Gris' }),
  // categoría solo por Bodega
  aviso({ item_id: 'MLC1000000005', sku_venta: 'PISO1', titulo: 'Pieza Decorativa Suave Beige' }),
  // Bodega dice «Textil Cama», que no es una categoría de la app
  aviso({ item_id: 'MLC1000000006', sku_venta: 'TC1', titulo: 'Protector Termico Suave Beige' }),
);

const productos: Fila[] = [];
for (let i = 0; i < 1100; i++) {
  productos.push({ id: nuevoId(), sku: `COMP${i}`, nombre: `Componente ${i}`, categoria: 'Otros', color: null, tamano: null });
}
productos.push(
  { id: nuevoId(), sku: '115799386112', nombre: 'Cama Mascota', categoria: 'Mascotas', color: null, tamano: null },
  { id: nuevoId(), sku: 'PISO1', nombre: 'Pieza Decorativa', categoria: 'Alfombras', color: null, tamano: null },
  { id: nuevoId(), sku: 'TC1', nombre: 'Protector Termico', categoria: 'Textil Cama', color: null, tamano: null },
);

const tablas: Record<string, Fila[]> = { ml_items_map: mlItems, productos };
let fallarTabla: string | null = null;

function filtrar(filas: Fila[], params: URLSearchParams): Fila[] {
  let out = filas;
  for (const [k, v] of params) {
    if (['select', 'order', 'offset', 'limit'].includes(k)) continue;
    if (k === 'or') {
      const skus = [...v.matchAll(/\.eq\."([^"]+)"/g)].map((m) => m[1]);
      out = out.filter((f) => skus.includes(String(f.sku_venta)) || skus.includes(String(f.sku)));
    } else if (v === 'eq.true') out = out.filter((f) => f[k] === true);
    else if (v === 'is.null') out = out.filter((f) => f[k] === null);
    else if (v.startsWith('eq.')) out = out.filter((f) => String(f[k]) === v.slice(3));
    else throw new Error(`filtro no simulado: ${k}=${v}`);
  }
  return out;
}

globalThis.fetch = (async (entrada: unknown) => {
  const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
  const tabla = url.pathname.replace('/rest/v1/', '');
  if (!(tabla in tablas)) return new Response('[]', { status: 404 });
  if (fallarTabla === tabla) {
    return new Response(JSON.stringify({ message: 'caída simulada' }), { status: 500 });
  }
  const p = url.searchParams;
  let filas = filtrar(tablas[tabla], p);
  if (p.get('order')?.startsWith('id')) filas = [...filas].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const desde = Number(p.get('offset') ?? 0);
  const cuantas = Math.min(Number(p.get('limit') ?? TOPE_SERVIDOR), TOPE_SERVIDOR);
  return new Response(JSON.stringify(filas.slice(desde, desde + cuantas)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}

interface V { sku: string; item_id?: string; status_ml?: string | null }
interface G { base_name: string; slug: string; categoria: string; variantes: V[] }

async function main() {
  const { GET } = await import('../src/app/api/productos/route');

  const res = await GET(new Request('http://app.test/api/productos'));
  const lista = (await res.json()) as G[];
  const buscar = (nombre: string) => lista.filter((g) => g.base_name === nombre);

  const lp = buscar(LP)[0];
  afirmar(!!lp, 'la familia de limpiapiés (después de la fila 1.000) está en la lista');
  const skusLp = (lp?.variantes ?? []).map((v) => v.sku).sort();
  afirmar(
    JSON.stringify(skusLp) === JSON.stringify(['ALPCMPRFK4060', 'ALPCMPRHR4060', 'ALPCMPRLN4060', 'ALPCMPRSL4060']),
    `limpiapiés: activa + pausada + sin clasificar, sin catálogo ni cerrada ni inactiva ni variación (${skusLp.join(', ')})`,
  );
  afirmar(lp?.categoria === 'limpiapies', `limpiapiés → limpiapies (${lp?.categoria})`);
  afirmar(lp?.variantes.find((v) => v.sku === 'ALPCMPRHR4060')?.status_ml === 'paused', 'la pausada viene marcada');
  const sol = lp?.variantes.filter((v) => v.sku === 'ALPCMPRSL4060') ?? [];
  afirmar(sol.length === 1 && sol[0].item_id === 'MLC2250580201', 'sku con dos avisos: una vez, con el activo');

  afirmar(buscar('Relleno Familia 599').length === 1, 'la última familia de relleno también está');
  afirmar(lista.filter((g) => g.base_name.startsWith('Relleno Familia')).length === 600, 'las 600 familias de relleno');

  const suelto = lista.find((g) => g.variantes.some((v) => v.sku === '115799386112'));
  afirmar(!!suelto && suelto.variantes.length === 1, 'el producto suelto aparece');
  afirmar(suelto?.categoria === '', `categoría desconocida → '' (${JSON.stringify(suelto?.categoria)})`);

  const sab = lista.find((g) => g.variantes.some((v) => v.sku === 'SAB1'));
  afirmar(sab?.categoria === 'sabanas', `«Sábanas» con tilde → sabanas (${sab?.categoria})`);
  const lp2 = lista.find((g) => g.variantes.some((v) => v.sku === 'LP2'));
  afirmar(lp2?.categoria === 'limpiapies', `«Alfombra Limpiapies» → limpiapies, no alfombras (${lp2?.categoria})`);
  const piso = lista.find((g) => g.variantes.some((v) => v.sku === 'PISO1'));
  afirmar(piso?.categoria === 'alfombras', `sin palabra, Bodega «Alfombras» → alfombras (${piso?.categoria})`);
  const tc = lista.find((g) => g.variantes.some((v) => v.sku === 'TC1'));
  afirmar(tc?.categoria === '', `Bodega «Textil Cama» no es de la app → '' (${JSON.stringify(tc?.categoria)})`);

  const slugs = lista.map((g) => g.slug);
  afirmar(new Set(slugs).size === slugs.length, 'ningún slug repetido');
  afirmar(buscar('Toalla Hotel').length === 2, 'las dos «Toalla Hotel» siguen separadas');

  afirmar(!lista.some((g) => g.base_name.startsWith('Componente')), 'los componentes sueltos de productos no ensucian la lista');

  const resSku = await GET(new Request('http://app.test/api/productos?sku=ALPCMPRHR4060'));
  const [solo] = (await resSku.json()) as G[];
  afirmar(solo?.variantes.length === 1 && solo.variantes[0].sku === 'ALPCMPRHR4060', '?sku= devuelve ese SKU solo');
  afirmar(!!solo && solo.slug !== lp?.slug, `?sku= con slug distinto al de su familia (${solo?.slug})`);
  afirmar(solo?.categoria === 'limpiapies', `?sku= con su categoría (${solo?.categoria})`);
  afirmar(solo?.variantes[0].status_ml === 'paused', '?sku= marca la pausada');

  fallarTabla = 'productos';
  const resError = await GET(new Request('http://app.test/api/productos'));
  afirmar(resError.status === 500, `error de la base → 500, no una lista a medias (${resError.status})`);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

// Módulo propio: sin esto sus nombres chocan con los de los otros scripts de prueba.
export {};

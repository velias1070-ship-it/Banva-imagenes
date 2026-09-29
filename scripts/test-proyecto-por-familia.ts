/**
 * Prueba de «un proyecto por familia de ML» contra dos bases simuladas (la de
 * inventario y la de la app) que, como las reales, entregan como máximo 1.000
 * filas por consulta.
 *
 * - GET missing-variants ofrece las variantes de la(s) familia(s) del proyecto
 *   que no están en NINGÚN proyecto: ni las propias (el SKU del swatch se
 *   compara sin mayúsculas), ni las de otro proyecto (esas se avisan), ni las
 *   de catálogo o cerradas, ni las de otra familia. Un producto que ML parte en
 *   dos familias por tamaño trae las dos.
 * - El SKU de otro proyecto que está después de la fila 1.000 de swatches se ve.
 * - POST agrega sólo lo ofrecido: primero a metadata.variantes (sin perder las
 *   otras llaves) y después el swatch sin foto, con el orden a continuación.
 *   Pedirlo dos veces no lo duplica. Un error de la base responde 500.
 * - GET indice-skus: SKU en mayúsculas → proyectos, sin repetir el proyecto.
 *
 * Uso: npx tsx scripts/test-proyecto-por-familia.ts  (no llama a ninguna API)
 */
process.env.INVENTORY_SUPABASE_URL = 'http://inventario.test';
process.env.INVENTORY_SUPABASE_KEY = 'clave-de-prueba';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://app-db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-prueba';

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

// --- Inventario ---
const mlItems: Fila[] = [];
for (let i = 0; i < 1050; i++) {
  mlItems.push(
    aviso({ item_id: `MLC9${i}`, sku_venta: `RELLENO${i}`, titulo: `Relleno ${i} Azul`, family_name: `Relleno ${i}` }),
  );
}
const QR2 = 'Quilt Roma 2 Plazas';
const QR15 = 'Quilt Roma 1.5 Plazas';
mlItems.push(
  aviso({ item_id: 'MLC1', sku_venta: 'QR2BE', titulo: `${QR2} Beige`, family_name: QR2 }),
  aviso({ item_id: 'MLC2', sku_venta: 'QR2GR', titulo: `${QR2} Gris`, family_name: QR2 }),
  aviso({ item_id: 'MLC3', sku_venta: 'QR2AZ', titulo: `${QR2} Azul`, family_name: QR2, status_ml: 'paused' }),
  aviso({ item_id: 'MLC4', sku_venta: 'QR2AZ', titulo: `${QR2} Azul`, family_name: QR2 }),
  aviso({ item_id: 'MLC5', sku_venta: 'QR2RO', titulo: `${QR2} Rosa`, family_name: QR2, status_ml: 'paused' }),
  aviso({ item_id: 'MLC6', sku_venta: 'QR2NE', titulo: `${QR2} Negro`, family_name: QR2 }),
  aviso({ item_id: 'MLC7', sku_venta: 'QR2MO', titulo: `${QR2} Morado`, family_name: QR2 }),
  aviso({ item_id: 'MLC8', sku_venta: 'QR2CAT', titulo: `${QR2} Catalogo`, family_name: QR2, catalog_listing: true }),
  aviso({ item_id: 'MLC9', sku_venta: 'QR2VE', titulo: `${QR2} Verde`, family_name: QR2, status_ml: 'closed' }),
  aviso({ item_id: 'MLC10', sku_venta: 'QR15BE', titulo: `${QR15} Beige`, family_name: QR15 }),
  aviso({ item_id: 'MLC11', sku_venta: 'QR15AZ', titulo: `${QR15} Azul`, family_name: QR15 }),
  aviso({ item_id: 'MLC12', sku_venta: 'SO1', titulo: 'Sabana Otra Blanca', family_name: 'Sabana Otra' }),
);

// --- App ---
const P1 = 'p1-quilt-roma';
const P2 = 'p2-roma-nuevo';
const P3 = 'p3-relleno';
const P4 = 'p4-vacio';
const projects: Fila[] = [
  { id: P1, name: 'Quilt Roma', metadata: { variantes: [{ sku: 'QR2BE', color: 'Beige' }, { sku: 'QR15BE', color: 'Beige' }], otra_cosa: 'x' } },
  { id: P2, name: 'roma nuevo', metadata: { variantes: [{ sku: 'QR2NE', color: 'Negro' }] } },
  { id: P3, name: 'Relleno', metadata: {} },
  { id: P4, name: 'Vacío', metadata: null },
];
const swatches: Fila[] = [];
const swatch = (project_id: string, sku_suffix: string | null, display_order: number): Fila => ({
  id: nuevoId(),
  project_id,
  name: sku_suffix,
  sku_suffix,
  storage_path: 'x.jpg',
  display_order,
});
for (let i = 0; i < 1100; i++) swatches.push(swatch(P3, `RELLSW${i}`, i));
swatches.push(
  swatch(P3, 'QR2MO', 1100), // después de la fila 1.000
  swatch(P3, null, 1101),
  swatch(P1, 'QR2BE', 0),
  swatch(P1, 'qr2gr', 1), // sólo como swatch y en minúsculas
  swatch(P2, 'QR2NE', 0),
);

const bases: Record<string, Record<string, Fila[]>> = {
  'inventario.test': { ml_items_map: mlItems, productos: [] },
  'app-db.test': { projects, swatches },
};
const escrituras: string[] = [];
let fallar: { tabla: string; metodo: string } | null = null;

function filtrar(filas: Fila[], params: URLSearchParams): Fila[] {
  let out = filas;
  for (const [k, v] of params) {
    if (['select', 'order', 'offset', 'limit', 'columns'].includes(k)) continue;
    if (v === 'eq.true') out = out.filter((f) => f[k] === true);
    else if (v === 'is.null') out = out.filter((f) => f[k] === null || f[k] === undefined);
    else if (v === 'not.is.null') out = out.filter((f) => f[k] !== null && f[k] !== undefined);
    else if (v.startsWith('eq.')) out = out.filter((f) => String(f[k]) === v.slice(3));
    else throw new Error(`filtro no simulado: ${k}=${v}`);
  }
  return out;
}

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
  const url = new URL(String(entrada instanceof Request ? entrada.url : entrada));
  const base = bases[url.host];
  const tabla = url.pathname.replace('/rest/v1/', '');
  if (!base || !(tabla in base)) return new Response('[]', { status: 404 });
  const metodo = (init?.method ?? 'GET').toUpperCase();
  if (fallar && fallar.tabla === tabla && fallar.metodo === metodo) {
    return json({ message: 'caída simulada' }, 500);
  }
  const p = url.searchParams;

  if (metodo === 'POST') {
    const cuerpo = JSON.parse(String(init?.body));
    const filas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]) as Fila[];
    for (const f of filas) base[tabla].push({ id: nuevoId(), ...f });
    escrituras.push(`POST ${tabla}`);
    return new Response(null, { status: 201 });
  }
  if (metodo === 'PATCH') {
    const cambios = JSON.parse(String(init?.body)) as Fila;
    for (const f of filtrar(base[tabla], p)) Object.assign(f, cambios);
    escrituras.push(`PATCH ${tabla}`);
    return new Response(null, { status: 204 });
  }

  let filas = filtrar(base[tabla], p);
  const orden = p.get('order');
  if (orden) {
    const [col, dir] = orden.split('.');
    filas = [...filas].sort((a, b) => {
      const c = typeof a[col] === 'number' ? (a[col] as number) - (b[col] as number) : String(a[col]).localeCompare(String(b[col]));
      return dir === 'desc' ? -c : c;
    });
  }
  const desde = Number(p.get('offset') ?? 0);
  const cuantas = Math.min(Number(p.get('limit') ?? TOPE_SERVIDOR), TOPE_SERVIDOR);
  filas = filas.slice(desde, desde + cuantas);
  if (new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object')) {
    return filas.length === 1 ? json(filas[0]) : json({ message: `${filas.length} filas` }, 406);
  }
  return json(filas);
}) as typeof fetch;

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}

interface Respuesta {
  familias: string[];
  nuevas: { sku: string; status_ml?: string | null }[];
  en_otros_proyectos: { id: string; name: string; variantes: number }[];
}

async function main() {
  const variantes = await import('../src/app/api/projects/[id]/missing-variants/route');
  const indiceRuta = await import('../src/app/api/projects/indice-skus/route');
  const ctx = (projectId: string) => ({ params: Promise.resolve({ id: projectId }) });
  const get = async (projectId: string) => {
    const res = await variantes.GET(new Request('http://app.test/x') as never, ctx(projectId));
    return { status: res.status, body: (await res.json()) as Respuesta };
  };
  const post = async (projectId: string, body: unknown) => {
    const res = await variantes.POST(
      new Request('http://app.test/x', { method: 'POST', body: JSON.stringify(body) }) as never,
      ctx(projectId),
    );
    return { status: res.status, body: await res.json() };
  };

  const r1 = await get(P1);
  afirmar(r1.status === 200, `GET del proyecto → 200 (${r1.status})`);
  const fams = [...(r1.body.familias ?? [])].sort();
  afirmar(JSON.stringify(fams) === JSON.stringify([QR15, QR2]), `las dos familias del proyecto partido por tamaño (${fams.join(' | ')})`);
  const skus = (r1.body.nuevas ?? []).map((v) => v.sku).sort();
  afirmar(
    JSON.stringify(skus) === JSON.stringify(['QR15AZ', 'QR2AZ', 'QR2RO']),
    `ofrece sólo las nuevas: sin las propias, las de otro proyecto, catálogo, cerrada ni otra familia (${skus.join(', ')})`,
  );
  afirmar(!skus.includes('QR2GR'), 'el swatch en minúsculas cuenta como propio');
  afirmar(r1.body.nuevas?.find((v) => v.sku === 'QR2RO')?.status_ml === 'paused', 'la pausada viene marcada');
  const otros = Object.fromEntries((r1.body.en_otros_proyectos ?? []).map((o) => [o.id, o.variantes]));
  afirmar(otros[P2] === 1, `avisa la variante que está en «roma nuevo» (${otros[P2]})`);
  afirmar(otros[P3] === 1, `ve el swatch de otro proyecto después de la fila 1.000 (${otros[P3]})`);

  const r404 = await get('no-existe');
  afirmar(r404.status === 404, `proyecto que no existe → 404 (${r404.status})`);
  const rVacio = await get(P4);
  afirmar(rVacio.status === 200 && rVacio.body.nuevas.length === 0 && rVacio.body.familias.length === 0, 'proyecto sin SKU → nada que ofrecer');

  const resIndice = await indiceRuta.GET();
  const indice = (await resIndice.json()) as Record<string, { id: string }[]>;
  afirmar(indice.QR2GR?.[0]?.id === P1, 'índice: SKU del swatch en mayúsculas → su proyecto');
  afirmar(indice.QR2BE?.length === 1, `índice: SKU en metadata y en swatch → el proyecto una vez (${indice.QR2BE?.length})`);
  afirmar(indice.QR2MO?.[0]?.id === P3, 'índice: ve el swatch después de la fila 1.000');

  const rMal = await post(P1, {});
  afirmar(rMal.status === 400, `POST sin skus → 400 (${rMal.status})`);

  escrituras.length = 0;
  const rAdd = await post(P1, { skus: ['qr2az', 'QR2NE', 'NOEXISTE'] });
  afirmar(rAdd.status === 200 && rAdd.body.agregadas === 1, `POST agrega sólo la ofrecida (${JSON.stringify(rAdd.body)})`);
  afirmar(
    JSON.stringify(rAdd.body.no_agregadas) === JSON.stringify(['QR2NE', 'NOEXISTE']),
    'POST dice cuáles no agregó',
  );
  afirmar(escrituras.join(',') === 'PATCH projects,POST swatches', `metadata primero, swatch después (${escrituras.join(',')})`);
  const p1 = projects.find((p) => p.id === P1)!.metadata as { variantes: { sku: string }[]; otra_cosa?: string };
  afirmar(p1.variantes.map((v) => v.sku).join(',') === 'QR2BE,QR15BE,QR2AZ', 'metadata.variantes suma la nueva al final');
  afirmar(p1.otra_cosa === 'x', 'metadata conserva sus otras llaves');
  const nuevoSw = swatches.filter((s) => s.project_id === P1 && s.sku_suffix === 'QR2AZ');
  afirmar(nuevoSw.length === 1 && nuevoSw[0].storage_path === '' && nuevoSw[0].display_order === 2, 'swatch sin foto, con el orden a continuación');

  const r2 = await get(P1);
  afirmar(!r2.body.nuevas.some((v) => v.sku === 'QR2AZ'), 'después de agregarla ya no se ofrece');
  const rOtra = await post(P1, { skus: ['QR2AZ'] });
  afirmar(rOtra.body.agregadas === 0 && swatches.filter((s) => s.sku_suffix === 'QR2AZ').length === 1, 'pedirla de nuevo no la duplica');

  fallar = { tabla: 'swatches', metodo: 'POST' };
  const rErr = await post(P1, { skus: ['QR2RO'] });
  afirmar(rErr.status === 500, `falla al crear el swatch → 500 (${rErr.status})`);
  fallar = { tabla: 'ml_items_map', metodo: 'GET' };
  const rErrInv = await get(P1);
  afirmar(rErrInv.status === 500, `falla la base de inventario → 500 (${rErrInv.status})`);
  fallar = { tabla: 'swatches', metodo: 'GET' };
  const rErrIdx = await indiceRuta.GET();
  afirmar(rErrIdx.status === 500, `falla la base de la app en el índice → 500 (${rErrIdx.status})`);

  console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
  process.exit(fallas === 0 ? 0 : 1);
}

main();

// Módulo propio: sin esto sus nombres chocan con los de los otros scripts de prueba.
export {};

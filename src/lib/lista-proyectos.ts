// Lógica pura de la lista de proyectos (/projects): los SKU de venta de cada
// proyecto, su familia de bodega, el orden y la búsqueda. Sin React, Next ni
// Supabase: la usan por igual la página (servidor) y la lista (cliente).

export interface FilaProyecto {
  id: string;
  name: string;
  category: string;
  sku_base: string | null;
  status: string;
  created_at: string;
  /** created_at ya formateada (dd-mm-aaaa, hora de Chile); null si la fecha no se puede leer. */
  fecha: string | null;
  /** SKU de venta del proyecto (variantes + swatches): MAYÚSCULAS, sin repetir, ordenados. */
  skus: string[];
  /**
   * Familias de bodega del proyecto (productos.familia), primero la que más SKU aporta.
   * null = no se pudo leer bodega ("no sé"). [] = se leyó y ningún SKU tiene familia.
   * Son dos estados distintos: no se mezclan ni se rellenan con un valor inventado.
   */
  familias: string[] | null;
}

// Un solo Collator para todo el orden: español y números por su valor (X2 < X10).
const collator = new Intl.Collator('es', { numeric: true });

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// SKU de venta de un proyecto: los de metadata.variantes[].sku más los
// sku_suffix de sus swatches (hay SKU que sólo están en swatches). Se le quitan
// los espacios, se pasa a MAYÚSCULAS y no se repite ninguno. La metadata viene
// de un JSON libre: si no es un objeto, si variantes no es un arreglo o si un
// sku no es texto (o está vacío), se ignora en vez de romper la página.
export function skusDeProyecto(metadata: unknown, sufijos: string[]): string[] {
  const vistos = new Set<string>();
  const agregar = (crudo: unknown) => {
    if (typeof crudo !== 'string') return;
    const sku = crudo.trim().toUpperCase();
    if (sku) vistos.add(sku);
  };

  const variantes = esObjeto(metadata) ? metadata.variantes : undefined;
  if (Array.isArray(variantes)) {
    for (const variante of variantes) {
      if (esObjeto(variante)) agregar(variante.sku);
    }
  }
  for (const sufijo of sufijos) agregar(sufijo);

  return [...vistos].sort(collator.compare);
}

// Familias de bodega de un conjunto de SKU. familiaPorSku es productos.sku →
// productos.familia con las llaves en MAYÚSCULAS (el SKU se busca en mayúsculas).
//   - Mapa null: bodega no se pudo leer → null. NUNCA [] ni una familia inventada.
//   - Mapa leído: las familias de los SKU que están en él. [] si ninguno tiene.
// Van ordenadas por cuántos SKU aporta cada una (la dominante primero) y, a
// igual cantidad, alfabéticamente.
export function familiasDe(skus: string[], familiaPorSku: ReadonlyMap<string, string> | null): string[] | null {
  if (familiaPorSku === null) return null;

  const aporte = new Map<string, number>();
  for (const sku of skus) {
    const familia = familiaPorSku.get(sku.trim().toUpperCase());
    if (familia) aporte.set(familia, (aporte.get(familia) ?? 0) + 1);
  }

  return [...aporte.entries()]
    .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
    .map(([familia]) => familia);
}

// Compara dos textos que pueden faltar: el que falta va DESPUÉS del que está.
function compararConFaltantes(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return collator.compare(a, b);
}

// Orden por defecto de la lista: por familia (la principal de cada proyecto),
// después por su menor SKU y por último por nombre. Sin familia (null o []) al
// final, y sin SKU al final de su familia. Devuelve una copia: no toca la entrada.
export function ordenarPorFamilia(filas: FilaProyecto[]): FilaProyecto[] {
  return [...filas].sort(
    (a, b) =>
      compararConFaltantes(a.familias?.[0], b.familias?.[0]) ||
      compararConFaltantes(a.skus[0], b.skus[0]) ||
      collator.compare(a.name, b.name),
  );
}

// Minúsculas y sin tildes: "Baño" y "bano" son lo mismo al buscar.
export function normalizar(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Búsqueda de la lista: cada palabra de q tiene que aparecer (AND), sin
// importar mayúsculas ni tildes, en el nombre, el sku_base, la categoría, algún
// SKU de venta o alguna familia. Una búsqueda vacía deja pasar todo.
export function coincide(fila: FilaProyecto, q: string): boolean {
  const palabras = normalizar(q).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return true;

  const texto = normalizar(
    [fila.name, fila.sku_base ?? '', fila.category, ...fila.skus, ...(fila.familias ?? [])].join(' '),
  );
  return palabras.every((palabra) => texto.includes(palabra));
}

// Se crea la primera vez que se usa: sólo la página (servidor) formatea fechas,
// y el navegador no tiene por qué construirlo.
let formatoFecha: Intl.DateTimeFormat | null = null;

// Fecha de created_at en hora de Chile (dd-mm-aaaa). Con la zona fija sale lo
// mismo en el servidor (UTC) y en el navegador: 2026-09-29T02:30:00Z es el
// 28-09-2026 en Santiago. Una fecha que no se puede leer devuelve null, no una
// fecha inventada.
export function formatearFecha(iso: string): string | null {
  if (!iso) return null;
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return null;
  formatoFecha ??= new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago' });
  return formatoFecha.format(fecha);
}

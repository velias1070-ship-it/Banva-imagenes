import { sinTildes, type ProductGroup } from '@/lib/familias-ml';
import type { ProyectoSkus } from '@/lib/proyectos-familia';

// Carpeta = un producto (p.ej. el quilt Atenas), con sus proyectos adentro.
// ML publica cada medida como una familia aparte (Atenas tiene cuatro: 1.5, 2
// plazas, King y Super King), así que la carpeta junta las familias que se
// llaman igual quitando las palabras de medida.
//
// Cómo se decide la carpeta de un proyecto:
// - la guardada en projects.metadata.carpeta (la pone «Mover» o «Renombrar»,
//   o la creación del proyecto);
// - si no tiene, la de su producto: la familia donde tiene más SKUs, con las
//   medidas juntas. Sin familia de ML → «Sin familia de ML».
//
// Límite: una carpeta guardada con el nombre de una automática (p.ej. mover
// Bruselas 1.5 a la carpeta de Bruselas 2 plazas) se separa si ML cambia ese
// nombre (renombra o cierra la familia que lo da): se vuelve a mover una vez.

export const SIN_FAMILIA = 'Sin familia de ML';
/** La de todos los proyectos sin carpeta guardada cuando no se pudieron leer las familias. */
export const SIN_AGRUPAR = 'Sin agrupar';
/** Nombres que no se pueden guardar: son de las carpetas comodín. */
export const CARPETAS_RESERVADAS = [SIN_FAMILIA, SIN_AGRUPAR];

// Palabras de medida, sin tildes y en singular. Los demás números se quedan:
// sábanas de 300 hilos y de 500 hilos son productos distintos.
const MEDIDAS = new Set([
  '1', '1.5', '1,5', '2', '2.0', '15p', '20p', '25p', '2p',
  'plaza', 'king', 'super', 'queen', 'full', 'y', 'media', 'medio',
]);

// Cobertores → cobertor, cubrecamas → cubrecama, Atena(s) → atena (ML corta
// el nombre de la familia a 60 caracteres).
function singular(palabra: string): string {
  if (palabra.length > 5 && palabra.endsWith('es') && 'rln'.includes(palabra[palabra.length - 3])) {
    return palabra.slice(0, -2);
  }
  if (palabra.length > 4 && palabra.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
}

function esMedida(palabra: string): boolean {
  const p = sinTildes(palabra);
  return MEDIDAS.has(p) || MEDIDAS.has(singular(p));
}

/** Llave del producto: las palabras del nombre de la familia sin las de medida. */
export function claveProducto(nombreFamilia: string): string {
  const palabras = nombreFamilia.split(/\s+/).filter((p) => p && !esMedida(p));
  const clave = [...new Set(palabras.map((p) => singular(sinTildes(p))))].sort().join(' ');
  return clave || sinTildes(nombreFamilia);
}

/** El nombre de la familia sin las palabras de medida, en su orden. */
export function nombreProducto(nombreFamilia: string): string {
  return nombreFamilia.split(/\s+/).filter((p) => p && !esMedida(p)).join(' ') || nombreFamilia;
}

/** Familia (base_name) → nombre de la carpeta de su producto. */
export function carpetaPorFamilia(familias: ProductGroup[]): Map<string, string> {
  const porClave = new Map<string, ProductGroup[]>();
  for (const g of familias) {
    const clave = claveProducto(g.base_name);
    porClave.set(clave, [...(porClave.get(clave) ?? []), g]);
  }
  const resultado = new Map<string, string>();
  for (const grupo of porClave.values()) {
    // El nombre sale de la primera familia por abecedario, no de la que tiene
    // más colores: así no cambia cada vez que ML agrega un color.
    const [primera] = [...grupo].sort((a, b) => a.base_name.localeCompare(b.base_name));
    const nombre = nombreProducto(primera.base_name);
    for (const g of grupo) resultado.set(g.base_name, nombre);
  }
  return resultado;
}

/** SKU (MAYÚSCULAS) → familias (base_name) donde está publicado. */
function familiasPorSku(familias: ProductGroup[]): Map<string, string[]> {
  const indice = new Map<string, string[]>();
  for (const g of familias) {
    for (const v of g.variantes) {
      const sku = v.sku.toUpperCase();
      const lista = indice.get(sku) ?? [];
      if (!lista.includes(g.base_name)) indice.set(sku, [...lista, g.base_name]);
    }
  }
  return indice;
}

/** La familia donde el proyecto tiene más SKUs (empate: alfabética), o null. */
function familiaPrincipal(skus: Set<string>, porSku: Map<string, string[]>): string | null {
  const cuenta = new Map<string, number>();
  for (const sku of skus) {
    for (const f of porSku.get(sku) ?? []) cuenta.set(f, (cuenta.get(f) ?? 0) + 1);
  }
  const [primera] = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return primera?.[0] ?? null;
}

/**
 * Carpeta de cada proyecto (id → nombre): la guardada o la de su producto.
 * `sinFamilia` es la carpeta de los que no tienen una: «Sin familia de ML», o
 * otra si no se pudieron leer las familias.
 */
export function carpetasDeProyectos(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  sinFamilia: string = SIN_FAMILIA,
): Map<string, string> {
  const porFamilia = carpetaPorFamilia(familias);
  const porSku = familiasPorSku(familias);
  const resultado = new Map<string, string>();
  for (const p of proyectos) {
    const principal = p.carpeta ? null : familiaPrincipal(p.skus, porSku);
    resultado.set(p.id, p.carpeta ?? (principal ? porFamilia.get(principal)! : sinFamilia));
  }
  return resultado;
}

/**
 * Carpeta a guardar en un proyecto recién creado, o null para no guardar nada
 * (queda en la de su producto y la sigue si ML la renombra). Se mira a los
 * otros proyectos que comparten SKUs con el nuevo; si ninguno, a los de su
 * mismo producto (cualquier medida). Gana la carpeta de la mayoría; en un
 * empate, la del producto, así un proyecto movido no arrastra a los nuevos.
 */
export function carpetaParaNuevo(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  projectId: string,
): string | null {
  const nuevo = proyectos.find((p) => p.id === projectId);
  if (!nuevo) return null;
  const porSku = familiasPorSku(familias);
  const porFamilia = carpetaPorFamilia(familias);
  const producto = (p: ProyectoSkus) => {
    const principal = familiaPrincipal(p.skus, porSku);
    return principal ? porFamilia.get(principal)! : null;
  };
  const suyo = producto(nuevo);
  const propia = suyo ?? SIN_FAMILIA;

  const otros = proyectos.filter((p) => p.id !== projectId);
  const comparten = otros.filter((p) => [...nuevo.skus].some((sku) => p.skus.has(sku)));
  const vecinos = comparten.length > 0 ? comparten : otros.filter((p) => suyo !== null && producto(p) === suyo);

  // Voto de cada vecino: la carpeta donde está, o null si está en la del
  // producto del nuevo sin haberla guardado (entonces no hay nada que guardar).
  const cuenta = new Map<string | null, number>([[null, 0]]);
  for (const p of vecinos) {
    const efectiva = p.carpeta ?? producto(p) ?? SIN_FAMILIA;
    const voto = p.carpeta === null && efectiva === propia ? null : efectiva;
    cuenta.set(voto, (cuenta.get(voto) ?? 0) + 1);
  }
  // La mayoría; en un empate gana null (la del producto: '' va primero en el abecedario).
  const [ganador] = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || (a[0] ?? '').localeCompare(b[0] ?? ''));
  return ganador[0];
}

export interface Carpeta {
  nombre: string;
  proyectos: { id: string; name: string; status: string | null; created_at: string | null }[];
}

/**
 * La lista de proyectos por carpeta: carpetas por nombre (la de sin familia al
 * final) y, adentro, lo más nuevo primero.
 */
export function agruparEnCarpetas(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  sinFamilia: string = SIN_FAMILIA,
): Carpeta[] {
  const carpetas = carpetasDeProyectos(familias, proyectos, sinFamilia);
  const porNombre = new Map<string, Carpeta>();
  for (const p of proyectos) {
    const nombre = carpetas.get(p.id)!;
    const carpeta = porNombre.get(nombre) ?? { nombre, proyectos: [] };
    carpeta.proyectos.push({ id: p.id, name: p.name, status: p.status, created_at: p.created_at });
    porNombre.set(nombre, carpeta);
  }
  for (const c of porNombre.values()) {
    c.proyectos.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }
  return [...porNombre.values()].sort(
    (a, b) => Number(a.nombre === sinFamilia) - Number(b.nombre === sinFamilia) || a.nombre.localeCompare(b.nombre, 'es'),
  );
}

/** Lo guardado en metadata.carpeta, o null si no hay un texto. */
export function carpetaGuardada(metadata: { carpeta?: unknown } | null): string | null {
  const c = metadata?.carpeta;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
}

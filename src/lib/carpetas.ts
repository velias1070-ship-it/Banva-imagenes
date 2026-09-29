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

export const SIN_FAMILIA = 'Sin familia de ML';

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
    // El nombre sale de la familia con más variantes (empate: alfabético).
    const [mayor] = [...grupo].sort(
      (a, b) => b.variantes.length - a.variantes.length || a.base_name.localeCompare(b.base_name),
    );
    const nombre = nombreProducto(mayor.base_name);
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
 * Carpeta para un proyecto recién creado: la más común entre los otros
 * proyectos de su misma familia principal (así cae en la carpeta renombrada o
 * movida); si no hay, la de su producto. null = no tiene familia de ML.
 */
export function carpetaParaNuevo(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  projectId: string,
): string | null {
  const nuevo = proyectos.find((p) => p.id === projectId);
  if (!nuevo) return null;
  const porSku = familiasPorSku(familias);
  const principal = familiaPrincipal(nuevo.skus, porSku);
  if (!principal) return null;

  const carpetas = carpetasDeProyectos(familias, proyectos);
  const cuenta = new Map<string, number>();
  for (const p of proyectos) {
    if (p.id === projectId || familiaPrincipal(p.skus, porSku) !== principal) continue;
    const c = carpetas.get(p.id)!;
    cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
  }
  const [masComun] = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return masComun?.[0] ?? carpetaPorFamilia(familias).get(principal)!;
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

import { sinTildes, type ProductGroup } from '@/lib/familias-ml';
import type { ProyectoSkus } from '@/lib/proyectos-familia';

// Buscar en la lista de proyectos por SKU venta, SKU origen, nombre del
// producto de origen o título de la publicación de ML.
// - El origen de cada SKU venta sale de composicion_venta de Bodega (la fuente
//   canónica, con sus unidades: un pack de 2 lleva ×2); el nombre, de productos.
// - Entran los SKU venta publicados en ML (activos o pausados) o que están en
//   algún proyecto: los que sólo existen en composicion_venta no tienen fotos
//   que hacer.
// - Al buscar se muestran, por cada SKU origen que calza, TODOS los SKU venta
//   que lo llevan (el individual, los packs, los combos) y en qué proyecto está
//   cada uno.
// - Las filas 'alternativo' de composicion_venta no cuentan: ese SKU venta no
//   lleva el origen (v_receta_componentes de Bodega hace lo mismo).

export interface OrigenVenta {
  sku: string;
  unidades: number;
}

export interface VentaIndice {
  /** SKU venta en MAYÚSCULAS. */
  sku: string;
  /** Título de la publicación de ML, o null si no está publicada. */
  titulo: string | null;
  origenes: OrigenVenta[];
  /** Ids de los proyectos que lo tienen. */
  proyectos: string[];
}

export interface IndiceBusqueda {
  ventas: VentaIndice[];
  /** SKU origen (MAYÚSCULAS) → nombre en Bodega. */
  nombres: Record<string, string>;
}

export interface FilaComposicion {
  sku_venta: string;
  sku_origen: string;
  unidades: number;
  tipo_relacion: string | null;
}

export interface FilaNombre {
  sku: string;
  nombre: string | null;
}

export function armarIndice(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  composicion: FilaComposicion[],
  productos: FilaNombre[],
): IndiceBusqueda {
  const norm = (sku: string) => sku.trim().toUpperCase();
  const titulos = new Map<string, string | null>();
  for (const g of familias) {
    for (const v of g.variantes) {
      const sku = norm(v.sku);
      if (!titulos.get(sku)) titulos.set(sku, v.titulo ?? null);
    }
  }
  const enProyectos = new Map<string, string[]>();
  for (const p of proyectos) {
    for (const sku of new Set([...p.skus].map(norm))) enProyectos.set(sku, [...(enProyectos.get(sku) ?? []), p.id]);
  }
  const origenes = new Map<string, OrigenVenta[]>();
  for (const c of composicion) {
    if (c.tipo_relacion === 'alternativo') continue;
    const venta = norm(c.sku_venta);
    const origen = norm(c.sku_origen);
    const lista = origenes.get(venta) ?? [];
    if (!lista.some((o) => o.sku === origen)) lista.push({ sku: origen, unidades: c.unidades });
    origenes.set(venta, lista);
  }

  const ventas = [...new Set([...titulos.keys(), ...enProyectos.keys()])].sort().map((sku) => ({
    sku,
    titulo: titulos.get(sku) ?? null,
    origenes: origenes.get(sku) ?? [],
    proyectos: enProyectos.get(sku) ?? [],
  }));
  const usados = new Set(ventas.flatMap((v) => v.origenes.map((o) => o.sku)));
  const nombres: Record<string, string> = {};
  for (const p of productos) {
    const sku = norm(p.sku);
    if (usados.has(sku) && p.nombre) nombres[sku] = p.nombre;
  }
  return { ventas, nombres };
}

export interface VentaEncontrada {
  sku: string;
  /** Unidades del origen del grupo, o null en el grupo sin origen. */
  unidades: number | null;
  /** Lleva más de un SKU origen. */
  combo: boolean;
  proyectos: string[];
}

export interface GrupoOrigen {
  /** null = SKU venta sin fila en composicion_venta. */
  origen: string | null;
  nombre: string | null;
  ventas: VentaEncontrada[];
}

export interface ResultadoSkus {
  /** Los SKU origen que calzan y, al final, el grupo sin origen si hay. */
  grupos: GrupoOrigen[];
  /** Lo que calza y no se muestra, SKU origen o SKU venta sin origen (se acota escribiendo más). */
  ocultos: number;
  /** Proyectos de los SKU venta que se muestran. */
  proyectos: Set<string>;
}

export const MAX_GRUPOS = 8;

/**
 * `tokens` ya en minúsculas y sin tildes; todos tienen que aparecer. Sale un
 * grupo por cada SKU origen que calza por sí mismo (SKU o nombre) o que es el
 * único origen de un SKU venta que calza (SKU o título). Un combo que calza
 * suma sus orígenes sólo si ninguno salió así: buscar «atenas» no trae la funda
 * del combo «Quilt Atenas con Funda»; buscar el combo trae los dos.
 */
export function buscarSkus(indice: IndiceBusqueda, tokens: string[], maxGrupos = MAX_GRUPOS): ResultadoSkus {
  if (tokens.length === 0) return { grupos: [], ocultos: 0, proyectos: new Set() };
  const calza = (...partes: (string | null)[]) => {
    const texto = sinTildes(partes.filter(Boolean).join(' '));
    return tokens.every((k) => texto.includes(k));
  };
  const fila = (v: VentaIndice, unidades: number | null): VentaEncontrada => ({
    sku: v.sku,
    unidades,
    combo: v.origenes.length > 1,
    proyectos: v.proyectos,
  });

  const porOrigen = new Map<string, VentaEncontrada[]>();
  for (const v of indice.ventas) {
    for (const o of v.origenes) porOrigen.set(o.sku, [...(porOrigen.get(o.sku) ?? []), fila(v, o.unidades)]);
  }
  const directas = indice.ventas.filter((v) => calza(v.sku, v.titulo));
  const base = new Set([...porOrigen.keys()].filter((o) => calza(o, indice.nombres[o] ?? null)));
  for (const v of directas) if (v.origenes.length === 1) base.add(v.origenes[0].sku);
  const origenes = new Set(base);
  for (const v of directas) {
    if (!v.origenes.some((o) => base.has(o.sku))) for (const o of v.origenes) origenes.add(o.sku);
  }

  const todos: GrupoOrigen[] = [...origenes]
    .map((origen) => ({
      origen,
      nombre: indice.nombres[origen] ?? null,
      // Primero los de una unidad, después los packs y al final los combos.
      ventas: [...porOrigen.get(origen)!].sort(
        (a, b) => Number(a.combo) - Number(b.combo) || a.unidades! - b.unidades! || a.sku.localeCompare(b.sku),
      ),
    }))
    // Primero lo buscado; después lo que trajo un combo.
    .sort(
      (a, b) =>
        Number(!base.has(a.origen)) - Number(!base.has(b.origen)) ||
        (a.nombre ?? a.origen).localeCompare(b.nombre ?? b.origen, 'es'),
    );
  const grupos = todos.slice(0, maxGrupos);
  const sinOrigen = directas.filter((v) => v.origenes.length === 0);
  if (sinOrigen.length > 0) {
    grupos.push({ origen: null, nombre: null, ventas: sinOrigen.slice(0, maxGrupos).map((v) => fila(v, null)) });
  }

  const proyectos = new Set(grupos.flatMap((g) => g.ventas.flatMap((v) => v.proyectos)));
  const ocultos = Math.max(0, todos.length - maxGrupos) + Math.max(0, sinOrigen.length - maxGrupos);
  return { grupos, ocultos, proyectos };
}

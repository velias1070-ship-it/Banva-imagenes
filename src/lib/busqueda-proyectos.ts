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
  const titulos = new Map<string, string | null>();
  for (const g of familias) {
    for (const v of g.variantes) {
      const sku = v.sku.toUpperCase();
      if (!titulos.get(sku)) titulos.set(sku, v.titulo ?? null);
    }
  }
  const enProyectos = new Map<string, string[]>();
  for (const p of proyectos) {
    for (const sku of p.skus) enProyectos.set(sku, [...(enProyectos.get(sku) ?? []), p.id]);
  }
  const origenes = new Map<string, OrigenVenta[]>();
  for (const c of composicion) {
    const venta = c.sku_venta.toUpperCase();
    const origen = c.sku_origen.toUpperCase();
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
    const sku = p.sku.toUpperCase();
    if (usados.has(sku) && p.nombre) nombres[sku] = p.nombre;
  }
  return { ventas, nombres };
}

export interface VentaEncontrada {
  sku: string;
  /** Unidades del origen del grupo, o null en el grupo sin origen. */
  unidades: number | null;
  proyectos: string[];
}

export interface GrupoOrigen {
  /** null = SKU venta sin fila en composicion_venta. */
  origen: string | null;
  nombre: string | null;
  ventas: VentaEncontrada[];
}

export interface ResultadoSkus {
  grupos: GrupoOrigen[];
  /** Grupos que calzan pero no se muestran (se acota escribiendo más). */
  ocultos: number;
  /** Proyectos que tienen alguno de los SKU venta encontrados (también los ocultos). */
  proyectos: Set<string>;
}

export const MAX_GRUPOS = 20;

/**
 * `tokens` ya en minúsculas y sin tildes; todos tienen que aparecer. Sale un
 * grupo por cada SKU origen que calza por sí mismo (SKU o nombre) o que lleva
 * un SKU venta que calza (SKU o título). Calzar sólo a través del origen no
 * suma los otros componentes de un combo: buscar el quilt no trae la funda.
 */
export function buscarSkus(indice: IndiceBusqueda, tokens: string[], maxGrupos = MAX_GRUPOS): ResultadoSkus {
  if (tokens.length === 0) return { grupos: [], ocultos: 0, proyectos: new Set() };
  const calza = (...partes: (string | null)[]) => {
    const texto = sinTildes(partes.filter(Boolean).join(' '));
    return tokens.every((k) => texto.includes(k));
  };

  const porOrigen = new Map<string, { sku: string; unidades: number; proyectos: string[] }[]>();
  for (const v of indice.ventas) {
    for (const o of v.origenes) {
      porOrigen.set(o.sku, [...(porOrigen.get(o.sku) ?? []), { sku: v.sku, unidades: o.unidades, proyectos: v.proyectos }]);
    }
  }
  const origenes = new Set([...porOrigen.keys()].filter((o) => calza(o, indice.nombres[o] ?? null)));
  const directas = indice.ventas.filter((v) => calza(v.sku, v.titulo));
  for (const v of directas) for (const o of v.origenes) origenes.add(o.sku);

  const grupos: GrupoOrigen[] = [...origenes]
    .map((origen) => ({
      origen,
      nombre: indice.nombres[origen] ?? null,
      ventas: [...porOrigen.get(origen)!].sort((a, b) => a.unidades - b.unidades || a.sku.localeCompare(b.sku)),
    }))
    .sort((a, b) => (a.nombre ?? a.origen).localeCompare(b.nombre ?? b.origen, 'es'));
  const sinOrigen = directas.filter((v) => v.origenes.length === 0);
  if (sinOrigen.length > 0) {
    grupos.push({
      origen: null,
      nombre: null,
      ventas: sinOrigen.map((v) => ({ sku: v.sku, unidades: null, proyectos: v.proyectos })),
    });
  }

  const proyectos = new Set(grupos.flatMap((g) => g.ventas.flatMap((v) => v.proyectos)));
  return { grupos: grupos.slice(0, maxGrupos), ocultos: Math.max(0, grupos.length - maxGrupos), proyectos };
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { leerTodo, listarFamilias, type ProductGroup, type Variante } from '@/lib/familias-ml';

// Un proyecto por familia de ML. La familia de un proyecto no se guarda: sale
// de sus SKUs (metadata.variantes y swatches) cruzados con ml_items_map, así
// sobrevive a que ML renombre la familia.

export interface ProyectoRef {
  id: string;
  name: string;
}

export interface ProyectoSkus extends ProyectoRef {
  /** SKUs en MAYÚSCULAS: metadata.variantes ∪ swatches.sku_suffix. */
  skus: Set<string>;
}

interface FilaProyecto {
  id: string;
  name: string;
  metadata: { variantes?: { sku?: string | null }[] } | null;
}

interface FilaSwatch {
  project_id: string;
  sku_suffix: string | null;
}

export async function leerProyectosConSkus(supabase: SupabaseClient): Promise<ProyectoSkus[]> {
  const [proyectos, swatches] = await Promise.all([
    leerTodo<FilaProyecto>((desde, hasta) =>
      supabase.from('projects').select('id, name, metadata').order('id').range(desde, hasta),
    ),
    leerTodo<FilaSwatch>((desde, hasta) =>
      supabase
        .from('swatches')
        .select('project_id, sku_suffix')
        .not('sku_suffix', 'is', null)
        .order('id')
        .range(desde, hasta),
    ),
  ]);

  const porId = new Map<string, ProyectoSkus>();
  for (const p of proyectos) {
    const skus = new Set<string>();
    for (const v of p.metadata?.variantes ?? []) {
      if (v?.sku) skus.add(v.sku.toUpperCase());
    }
    porId.set(p.id, { id: p.id, name: p.name, skus });
  }
  for (const s of swatches) {
    if (s.sku_suffix) porId.get(s.project_id)?.skus.add(s.sku_suffix.toUpperCase());
  }
  return [...porId.values()];
}

/** SKU (MAYÚSCULAS) → proyectos que lo tienen. */
export function indicePorSku(proyectos: ProyectoSkus[]): Record<string, ProyectoRef[]> {
  const indice: Record<string, ProyectoRef[]> = {};
  for (const p of proyectos) {
    for (const sku of p.skus) {
      (indice[sku] ??= []).push({ id: p.id, name: p.name });
    }
  }
  return indice;
}

export interface VariantesNuevas {
  /** Familias de ML del proyecto (base_name). Un producto que ML parte por tamaño trae 2-3. */
  familias: string[];
  /** Variantes de esas familias que no están en ningún proyecto. */
  nuevas: Variante[];
  /** Variantes de esas familias que ya están en OTRO proyecto: no se ofrecen, se avisan. */
  en_otros_proyectos: (ProyectoRef & { variantes: number })[];
}

// null = el proyecto no existe.
export function calcularVariantesNuevas(
  familias: ProductGroup[],
  proyectos: ProyectoSkus[],
  projectId: string,
): VariantesNuevas | null {
  const proyecto = proyectos.find((p) => p.id === projectId);
  if (!proyecto) return null;

  const suyas = familias.filter((g) => g.variantes.some((v) => proyecto.skus.has(v.sku.toUpperCase())));
  const indice = indicePorSku(proyectos.filter((p) => p.id !== projectId));

  const nuevas: Variante[] = [];
  const otros = new Map<string, ProyectoRef & { variantes: number }>();
  const vistas = new Set<string>();
  for (const g of suyas) {
    for (const v of g.variantes) {
      const sku = v.sku.toUpperCase();
      if (proyecto.skus.has(sku) || vistas.has(sku)) continue;
      vistas.add(sku);
      const ajenos = indice[sku];
      if (!ajenos) {
        nuevas.push(v);
        continue;
      }
      for (const ref of ajenos) {
        const o = otros.get(ref.id) ?? { ...ref, variantes: 0 };
        o.variantes += 1;
        otros.set(ref.id, o);
      }
    }
  }

  return {
    familias: suyas.map((g) => g.base_name),
    nuevas,
    en_otros_proyectos: [...otros.values()].sort((a, b) => b.variantes - a.variantes),
  };
}

export async function leerVariantesNuevas(
  inventario: SupabaseClient,
  app: SupabaseClient,
  projectId: string,
): Promise<VariantesNuevas | null> {
  const [familias, proyectos] = await Promise.all([listarFamilias(inventario), leerProyectosConSkus(app)]);
  return calcularVariantesNuevas(familias, proyectos, projectId);
}

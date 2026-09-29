import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PRODUCT_CATEGORIES } from '@/lib/constants';

// Familias de publicaciones de ML tal como las ve la app: la lista de «crear
// proyecto» (/api/productos) y las variantes nuevas de un proyecto salen de acá,
// para que las dos digan lo mismo.
// Palabra del nombre → categoría de la app. Se compara SIN tildes ("Juego de
// sábanas" caía en 'otros'), y lo específico va antes que lo genérico
// ("Alfombra Limpia Pies…" es limpiapies, no alfombras).
const CATEGORY_MAP: Record<string, string> = {
  limpiapies: 'limpiapies',
  'limpia pies': 'limpiapies',
  choapino: 'limpiapies',
  'cubre colchon': 'cubre-colchon',
  matero: 'bolsos-materos',
  sabana: 'sabanas',
  toalla: 'toallas',
  mantel: 'manteles',
  cubrecama: 'cubrecamas',
  quilt: 'quilts',
  plumon: 'plumones',
  frazada: 'frazadas',
  manta: 'frazadas',
  topper: 'toppers',
  alfombra: 'alfombras',
  heatset: 'alfombras',
  frise: 'alfombras',
  cortina: 'cortinas',
  cubrecolchon: 'cubre-colchon',
  almohada: 'almohadas',
  bolso: 'bolsos-cuero',
};

const CATEGORIAS_APP = new Set<string>(PRODUCT_CATEGORIES.map((c) => c.key));

export function sinTildes(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Categoría de la app para un producto, o '' si no se sabe: el formulario
// obliga a elegirla en vez de caer callado a la estrategia genérica. La
// categoría de Bodega ("Textil Cama", "Textil Baño"…) solo sirve si calza con
// una de la app ("Alfombras", "Almohada").
export function inferCategory(nombre: string, categoriaBodega?: string | null): string {
  const n = sinTildes(nombre);
  for (const [keyword, cat] of Object.entries(CATEGORY_MAP)) {
    if (n.includes(keyword)) return cat;
  }
  const b = sinTildes(categoriaBodega || '');
  if (CATEGORIAS_APP.has(b)) return b;
  if (CATEGORIAS_APP.has(`${b}s`)) return `${b}s`;
  return '';
}

// La base de inventario entrega como máximo 1.000 filas por consulta aunque se
// pida más: con .limit(2000) la lista perdía publicaciones (29-sep-2026: el
// limpiapiés de coco MLC2250580065 no aparecía). Se lee por páginas, ordenado
// por id, hasta una página vacía.
export async function leerTodo<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const filas: T[] = [];
  for (;;) {
    const { data, error } = await pagina(filas.length, filas.length + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return filas;
    filas.push(...data);
  }
}

// Tradicional y activa o pausada (una pausada se reactiva con fotos nuevas).
// A una de catálogo ML no le deja cambiar las fotos; catalog_listing NULL = el
// sync aún no la clasificó: entra, y publicar la revalida contra ML.
export function esVisible(item: { catalog_listing: boolean | null; status_ml: string | null }): boolean {
  if (item.catalog_listing === true) return false;
  return !item.status_ml || item.status_ml === 'active' || item.status_ml === 'paused';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[%]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '');
}

// fallbackKey replicates banvabodega's AdminComercial.tsx pattern: when an
// item has no family_name (legacy or unlinked to ML catalog), group by title
// minus its last word — the last word is usually the variant modifier (color,
// size, plazas, etc.).
function fallbackKey(title: string): string {
  if (!title) return '';
  const words = title.trim().split(/\s+/);
  if (words.length <= 1) return slugify(title);
  return slugify(words.slice(0, -1).join(' '));
}

const PATTERN_TYPES = new Set([
  'estampado', 'estampados', 'liso', 'lisos',
  'estampada', 'estampadas', 'lisa', 'lisas',
  'bordado', 'bordados', 'jacquard',
]);

// Splits the variant suffix of an ML title into { color, tipo }.
// e.g. "Sabanas Polar … Cala Estampado" → { color: "Cala", tipo: "Estampado" }
//      "… Azul Liso"                    → { color: "Azul", tipo: "Liso" }
//      "… Cobre"                        → { color: "Cobre", tipo: null }
export function parseVariantLabel(title: string, familyName: string | null): { color: string; tipo: string | null } {
  if (!title) return { color: '', tipo: null };
  let tail = title.trim();
  // Strip the family_name prefix if present so we only parse the variant suffix
  if (familyName && tail.toLowerCase().startsWith(familyName.toLowerCase())) {
    tail = tail.slice(familyName.length).trim();
  }
  const words = tail.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { color: '', tipo: null };

  const last = words[words.length - 1];
  const isType = PATTERN_TYPES.has(last.toLowerCase());

  if (isType && words.length >= 2) {
    const color = words[words.length - 2];
    return { color, tipo: last };
  }
  return { color: last, tipo: null };
}

export interface Variante {
  sku: string;
  color: string;
  color_slug: string;
  source: 'catalogo' | 'ml';
  item_id?: string;
  titulo?: string;
  thumbnail?: string;
  permalink?: string;
  tipo?: string | null;
  bed_size?: string | null;
  label?: string;
  /** 'active' | 'paused' | null (sin sincronizar). */
  status_ml?: string | null;
}

export interface FilaMl {
  item_id: string;
  sku: string | null;
  sku_venta: string | null;
  titulo: string | null;
  family_name: string | null;
  thumbnail: string | null;
  permalink: string | null;
  bed_size: string | null;
  status_ml: string | null;
  catalog_listing: boolean | null;
}

export interface FilaProducto {
  sku: string;
  nombre: string;
  categoria: string | null;
  color: string | null;
  tamano: string | null;
}

export interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  family_name: string | null;
  variantes: Variante[];
}

// Base de inventario (ml_items_map, productos: la de Bodega prod), o null si
// faltan las variables. Sin respaldo a NEXT_PUBLIC_SUPABASE_URL: esa es la base
// de la app (gwkarh…), que tiene una copia de ml_items_map congelada en mayo
// 2026 y daría familias viejas sin ningún error.
export function clienteInventario(): SupabaseClient | null {
  const url = process.env.INVENTORY_SUPABASE_URL;
  const key = process.env.INVENTORY_SUPABASE_KEY;
  return url && key ? createClient(url, key) : null;
}

// Todas las familias de ML (publicaciones tradicionales activas y pausadas),
// agrupadas por family_name (como AdminComercial.tsx:596 de banvabodega) o, si
// falta, por el título menos su última palabra. `productos` solo enriquece
// (categoría, color, tamaño).
export async function listarFamilias(supabase: SupabaseClient): Promise<ProductGroup[]> {
  const [mlItems, productos] = await Promise.all([
    leerTodo<FilaMl>((desde, hasta) =>
      supabase
        .from('ml_items_map')
        .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size, status_ml, catalog_listing')
        .eq('activo', true)
        .is('variation_id', null)
        .order('id')
        .range(desde, hasta),
    ),
    leerTodo<FilaProducto>((desde, hasta) =>
      supabase
        .from('productos')
        .select('sku, nombre, categoria, color, tamano')
        .order('id')
        .range(desde, hasta),
    ),
  ]);

  const productosBySku = new Map(productos.map((p) => [p.sku, p]));

  const groups = new Map<string, ProductGroup>();

  // Primary path: ML items grouped by family_name (or fallback)
  for (const item of mlItems) {
    if (!esVisible(item)) continue;

    const titulo: string = item.titulo || '';
    const familyName: string | null = item.family_name || null;
    const key = familyName ? `fam:${familyName}` : `fk:${fallbackKey(titulo)}`;
    if (key === 'fk:') continue; // no titulo to fall back on

    const sku = item.sku_venta || item.sku || '';
    const producto = sku ? productosBySku.get(sku) : undefined;

    // Parse "{color} {tipo}" out of the title — e.g. "Cala Estampado", "Azul Liso"
    const parsed = parseVariantLabel(titulo, familyName);
    const color = producto?.color || parsed.color || sku || item.item_id;
    const tipo = parsed.tipo || null;
    const bedSize = item.bed_size || producto?.tamano || null;

    const labelParts = [color, tipo, bedSize].filter(Boolean);
    const label = labelParts.join(' · ');

    if (!groups.has(key)) {
      const baseName = familyName || (titulo ? titulo.split(/\s+/).slice(0, -1).join(' ') : '');
      groups.set(key, {
        base_name: baseName,
        slug: slugify(baseName),
        tamano: producto?.tamano || '',
        categoria: '',
        family_name: familyName,
        variantes: [],
      });
    }

    const group = groups.get(key)!;
    if (!group.categoria) {
      group.categoria = inferCategory(group.base_name) || inferCategory(titulo, producto?.categoria);
    }

    // Un mismo sku_venta puede tener dos avisos tradicionales (o filas de
    // un combo): va una sola vez, con el aviso activo si lo hay.
    const skuVariante = sku || item.item_id;
    const previa = group.variantes.findIndex((v) => v.sku === skuVariante);
    if (previa >= 0) {
      if (group.variantes[previa].status_ml === 'paused' && item.status_ml !== 'paused') {
        group.variantes.splice(previa, 1);
      } else {
        continue;
      }
    }

    group.variantes.push({
      sku: skuVariante,
      color,
      // color_slug identifica el "diseño" — NO incluye bed_size porque el
      // tamaño es un eje independiente. Si lo metiéramos acá, el resolver
      // contaría "Aba 1.0 plaza" y "Aba 1.5 plazas" como diseños distintos.
      color_slug: slugify(`${color}-${tipo || ''}`) || slugify(color),
      source: producto ? 'catalogo' : 'ml',
      item_id: item.item_id,
      titulo: titulo || undefined,
      thumbnail: item.thumbnail || undefined,
      permalink: item.permalink || undefined,
      tipo,
      bed_size: bedSize,
      label,
      status_ml: item.status_ml,
    });
  }

  // Output: todas las familias de ML, también las de una sola variante (un
  // producto suelto se puede trabajar solo). Sort by tipo (Estampado/Liso/etc),
  // then by color, then by bed_size — that way variants of the same design
  // line up consecutively in the UI.
  const result: ProductGroup[] = [];
  for (const [, g] of groups) {
    g.variantes.sort((a, b) => {
      const t = (a.tipo || '').localeCompare(b.tipo || '');
      if (t !== 0) return t;
      const c = a.color.localeCompare(b.color);
      if (c !== 0) return c;
      return (a.bed_size || '').localeCompare(b.bed_size || '');
    });
    result.push(g);
  }

  result.sort((a, b) => a.base_name.localeCompare(b.base_name));

  // La pantalla selecciona por slug: dos familias con el mismo nombre se
  // marcaban juntas. El segundo lleva sufijo.
  const slugsUsados = new Map<string, number>();
  for (const g of result) {
    const n = (slugsUsados.get(g.slug) ?? 0) + 1;
    slugsUsados.set(g.slug, n);
    if (n > 1) g.slug = `${g.slug}-${n}`;
  }

  return result;
}

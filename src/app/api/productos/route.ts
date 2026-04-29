import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const CATEGORY_MAP: Record<string, string> = {
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
  limpiapies: 'limpiapies',
  cortina: 'cortinas',
  cubrecolchon: 'cubre-colchon',
  almohada: 'almohadas',
  bolso: 'bolsos-cuero',
};

function inferCategory(nombre: string): string {
  const lower = nombre.toLowerCase();
  for (const [keyword, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword)) return cat;
  }
  return 'otros';
}

function slugify(text: string): string {
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
function parseVariantLabel(title: string, familyName: string | null): { color: string; tipo: string | null } {
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

interface Variante {
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
}

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  family_name: string | null;
  variantes: Variante[];
}

// GET /api/productos
// Groups ML items by family_name (the way banvabodega does it in
// AdminComercial.tsx:596). Falls back to title-minus-last-word when an item
// has no family_name (legacy items not linked to ML's catalog).
//
// Productos table is used as a SECONDARY enrichment source: if a SKU exists
// in productos, we use its category/color/tamano fields to enrich the variant.
export async function GET() {
  try {
    const supabaseUrl = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.INVENTORY_SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const [mlItemsRes, productosRes] = await Promise.all([
      supabase
        .from('ml_items_map')
        .select('item_id, sku, sku_venta, titulo, family_name, thumbnail, permalink, bed_size')
        .eq('activo', true)
        .is('variation_id', null)
        .limit(2000),
      supabase
        .from('productos')
        .select('sku, nombre, categoria, color, tamano')
        .limit(5000),
    ]);

    if (mlItemsRes.error) {
      return NextResponse.json({ error: mlItemsRes.error.message }, { status: 500 });
    }

    const mlItems = mlItemsRes.data || [];
    const productos = productosRes.data || [];
    const productosBySku = new Map(productos.map((p) => [p.sku, p]));

    const groups = new Map<string, ProductGroup>();

    // Primary path: ML items grouped by family_name (or fallback)
    for (const item of mlItems) {
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
          categoria: inferCategory(baseName),
          family_name: familyName,
          variantes: [],
        });
      }

      const group = groups.get(key)!;
      group.variantes.push({
        sku: sku || item.item_id,
        color,
        color_slug: slugify(`${color}-${tipo || ''}-${bedSize || ''}`),
        source: producto ? 'catalogo' : 'ml',
        item_id: item.item_id,
        titulo: titulo || undefined,
        thumbnail: item.thumbnail || undefined,
        permalink: item.permalink || undefined,
        tipo,
        bed_size: bedSize,
        label,
      });
    }

    // Secondary path: productos NOT covered by ML items (legacy / not yet
    // listed). Group by base name + size — same as the previous heuristic.
    const coveredSkus = new Set(
      mlItems.map((i) => i.sku_venta).filter((s): s is string => !!s)
    );

    const productosFallback = new Map<string, ProductGroup>();
    for (const row of productos) {
      if (coveredSkus.has(row.sku)) continue;
      let color = row.color || '';
      if (!color) {
        const words = row.nombre.trim().split(/\s+/);
        if (words.length > 1) color = words[words.length - 1];
      }
      if (!color) continue;
      const tamano = row.tamano || '';
      const baseName = color
        ? row.nombre.replace(color, '').replace(/\s{2,}/g, ' ').trim()
        : row.nombre;
      const key = `prod:${slugify(baseName)}|${tamano.toLowerCase()}`;
      if (!productosFallback.has(key)) {
        productosFallback.set(key, {
          base_name: baseName,
          slug: slugify(baseName),
          tamano,
          categoria: row.categoria || inferCategory(baseName),
          family_name: null,
          variantes: [],
        });
      }
      productosFallback.get(key)!.variantes.push({
        sku: row.sku,
        color,
        color_slug: slugify(color),
        source: 'catalogo',
      });
    }

    // Merge — productos fallback only included if 2+ variants
    for (const [, g] of productosFallback) {
      if (g.variantes.length < 2) continue;
      groups.set(`prod-only:${g.slug}|${g.tamano.toLowerCase()}`, g);
    }

    // Output: only groups with 2+ variants. Sort by tipo (Estampado/Liso/etc),
    // then by color, then by bed_size — that way variants of the same design
    // line up consecutively in the UI.
    const result: ProductGroup[] = [];
    for (const [, g] of groups) {
      if (g.variantes.length < 2) continue;
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

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GET /api/productos] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

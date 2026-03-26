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

function extractBaseName(nombre: string, color: string): string {
  let base = color ? nombre.replace(color, '').trim() : nombre;
  base = base.replace(/\s+[SWAPX]\d{2,3}\s*$/, '').trim();
  base = base.replace(/\s+PT\s*$/, '').trim();
  base = base.replace(/\s{2,}/g, ' ').trim();
  return base;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[%]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '');
}

function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  // Remove trailing color chars — keep only the size-encoded part
  // e.g. "TXV23QLAT25" from "TXV23QLAT25BE" and "TXV23QLAT25BC"
  return prefix;
}

interface Variante {
  sku: string;
  color: string;
  color_slug: string;
  source: 'catalogo' | 'ml';
}

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  variantes: Variante[];
}

// GET /api/productos — returns products grouped by base, merging productos + ml_items_map
export async function GET() {
  try {
  const supabaseUrl = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.INVENTORY_SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch both tables in parallel
  const [productosRes, mlItemsRes] = await Promise.all([
    supabase
      .from('productos')
      .select('sku, nombre, categoria, color, tamano')
      .order('nombre')
      .limit(2000),
    supabase
      .from('ml_items_map')
      .select('sku_venta, item_id, titulo')
      .eq('activo', true)
      .is('variation_id', null)
      .limit(2000),
  ]);

  if (productosRes.error) {
    return NextResponse.json({ error: productosRes.error.message }, { status: 500 });
  }

  const productos = productosRes.data || [];
  const mlItems = mlItemsRes.data || [];

  // 1. Group productos by base product
  const groups = new Map<string, { base: string; tamano: string; variantes: Map<string, Variante> }>();

  for (const row of productos) {
    // Infer color from nombre if field is empty
    let color = row.color || '';
    if (!color) {
      const words = row.nombre.trim().split(/\s+/);
      // Last word is usually the color (e.g. "Set 6 Toallas Valencia Azul" → "Azul")
      if (words.length > 1) {
        color = words[words.length - 1];
      }
    }
    if (!color) continue;

    const tamano = row.tamano || '';
    const base = extractBaseName(row.nombre, color);
    const key = `${base}|||${tamano.trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, { base, tamano, variantes: new Map() });
    }
    groups.get(key)!.variantes.set(row.sku, {
      sku: row.sku,
      color: color,
      color_slug: slugify(color),
      source: 'catalogo',
    });
  }

  // 2. Enrich with ml_items_map — find ML listings that share SKU prefix with existing groups
  for (const [, group] of groups) {
    const existingSkus = Array.from(group.variantes.keys());
    if (existingSkus.length === 0) continue;

    // Find common SKU prefix from existing variants
    // e.g. TXV23QLAT25BE, TXV23QLAT25BC → prefix = "TXV23QLAT25"
    const skuPrefix = findCommonPrefix(existingSkus);
    if (skuPrefix.length < 6) continue; // Too short, would match too broadly

    const existingSkuSet = new Set(existingSkus);

    for (const ml of mlItems) {
      if (!ml.sku_venta) continue;
      if (existingSkuSet.has(ml.sku_venta)) continue;
      if (!ml.sku_venta.startsWith(skuPrefix)) continue;

      // Extract color from the ML title — last meaningful word
      const titleWords = ml.titulo.split(/\s+/);
      let colorGuess = ml.sku_venta;
      for (let i = titleWords.length - 1; i >= 0; i--) {
        const w = titleWords[i];
        if (w && !/^\d/.test(w) && w.length > 1 && !['Cm', 'M', 'Plazas', 'Plaza', 'King', 'Super'].includes(w)) {
          colorGuess = w;
          break;
        }
      }

      existingSkuSet.add(ml.sku_venta);
      group.variantes.set(ml.sku_venta, {
        sku: ml.sku_venta,
        color: colorGuess,
        color_slug: slugify(colorGuess),
        source: 'ml',
      });
    }
  }

  // 3. Also find ML-only groups (products in ML but NOT in productos table)
  const allCatalogSkus = new Set(productos.map((p) => p.sku));
  const mlOnlyItems = mlItems.filter((ml) => ml.sku_venta && !allCatalogSkus.has(ml.sku_venta));

  // Group ML-only items by title keywords
  const mlGroups = new Map<string, { titulo: string; items: typeof mlItems }>();
  for (const ml of mlOnlyItems) {
    // Use first N words of title as group key (strip color at end)
    const words = ml.titulo.split(/\s+/);
    // Try to find a good grouping — use all words except the last one (usually color)
    const baseWords = words.slice(0, -1).join(' ');
    const key = slugify(baseWords);
    if (!mlGroups.has(key)) mlGroups.set(key, { titulo: baseWords, items: [] });
    mlGroups.get(key)!.items.push(ml);
  }

  // Add ML-only groups with 2+ variants
  for (const [key, mlGroup] of mlGroups) {
    if (mlGroup.items.length < 2) continue;
    if (groups.has(key)) continue; // Already covered

    const variantes = new Map<string, Variante>();
    for (const ml of mlGroup.items) {
      const titleWords = ml.titulo.split(/\s+/);
      const colorGuess = titleWords[titleWords.length - 1] || ml.sku_venta;
      variantes.set(ml.sku_venta, {
        sku: ml.sku_venta,
        color: colorGuess,
        color_slug: slugify(colorGuess),
        source: 'ml',
      });
    }

    groups.set(key, {
      base: mlGroup.titulo,
      tamano: '',
      variantes,
    });
  }

  // 4. Build response — only groups with 2+ variants
  const result: ProductGroup[] = [];

  for (const [, group] of groups) {
    if (group.variantes.size < 2) continue;

    const variantesArr = Array.from(group.variantes.values());
    result.push({
      base_name: group.base,
      slug: slugify(group.base),
      tamano: group.tamano,
      categoria: inferCategory(group.base),
      variantes: variantesArr,
    });
  }

  result.sort((a, b) => a.base_name.localeCompare(b.base_name));

  return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GET /api/productos] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

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

interface Producto {
  sku: string;
  nombre: string;
  categoria: string;
  color: string | null;
  tamano: string | null;
}

interface ProductGroup {
  base_name: string;
  slug: string;
  tamano: string;
  categoria: string;
  variantes: {
    sku: string;
    color: string;
    color_slug: string;
  }[];
}

// GET /api/productos — returns products from Supabase grouped by base product
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from('productos')
    .select('sku, nombre, categoria, color, tamano')
    .order('nombre');

  if (error) {
    return NextResponse.json({ error: error.message, details: error }, { status: 500 });
  }

  // Group by base product (shared hero shots, differ in color)
  const groups = new Map<string, Producto[]>();

  for (const row of data as Producto[]) {
    if (!row.color || !row.tamano) continue;
    const base = extractBaseName(row.nombre, row.color);
    const key = `${base}|||${row.tamano.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Build response: only groups with 2+ variants
  const result: ProductGroup[] = [];

  for (const [, items] of groups) {
    if (items.length < 2) continue;

    const base = extractBaseName(items[0].nombre, items[0].color!);
    result.push({
      base_name: base,
      slug: slugify(base),
      tamano: items[0].tamano!,
      categoria: inferCategory(items[0].nombre),
      variantes: items.map((item) => ({
        sku: item.sku,
        color: item.color!,
        color_slug: slugify(item.color!),
      })),
    });
  }

  result.sort((a, b) => a.base_name.localeCompare(b.base_name));

  return NextResponse.json(result);
}

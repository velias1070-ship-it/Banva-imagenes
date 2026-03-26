import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get('q') || '';
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ error: 'No supabase config' }, { status: 500 });

  const sb = createClient(url, key);
  const { data, error } = await sb
    .from('productos')
    .select('sku, nombre, color, tamano, categoria')
    .ilike('nombre', `%${search}%`)
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

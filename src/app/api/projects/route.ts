import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export async function GET() {
  const supabase = await createServerSupabase();

  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(projects);
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { name, category, sku_base, description, variantes } = body;

  if (!name || !category) {
    return NextResponse.json(
      { error: 'name and category are required' },
      { status: 400 }
    );
  }

  const slug = slugify(name);

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      name,
      slug,
      category,
      sku_base: sku_base || null,
      description: description || null,
      status: 'draft',
      metadata: variantes ? { variantes } : {},
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If variantes came from the catalog, create swatch placeholders
  if (variantes && Array.isArray(variantes) && project) {
    const swatchRows = variantes.map((v: { sku: string; color: string; color_slug: string }, i: number) => ({
      project_id: project.id,
      name: v.color,
      sku_suffix: v.sku,
      color_description: v.color,
      storage_path: '',
      display_order: i,
    }));

    await supabase.from('swatches').insert(swatchRows);
  }

  return NextResponse.json(project, { status: 201 });
}

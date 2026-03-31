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
  const { data: brands, error } = await supabase
    .from('brands')
    .select('*')
    .order('name');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(brands);
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { name, primary_color, secondary_color, accent_color, typography, prompt_guidelines,
    logo_position, logo_margin_px, logo_size_px, apply_logo_overlay, apply_to_shot_types } = body;

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const { data: brand, error } = await supabase
    .from('brands')
    .insert({
      name,
      slug: slugify(name),
      primary_color: primary_color || '#000000',
      secondary_color: secondary_color || '#666666',
      accent_color: accent_color || '#7CB9D6',
      typography: typography || '',
      prompt_guidelines: prompt_guidelines || '',
      logo_position: logo_position || 'top-left',
      logo_margin_px: logo_margin_px || 40,
      logo_size_px: logo_size_px || 150,
      apply_logo_overlay: apply_logo_overlay ?? true,
      apply_to_shot_types: apply_to_shot_types || [],
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(brand, { status: 201 });
}

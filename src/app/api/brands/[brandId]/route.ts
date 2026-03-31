import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ brandId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { brandId } = await context.params;
  const supabase = await createServerSupabase();

  const { data: brand, error } = await supabase
    .from('brands')
    .select('*')
    .eq('id', brandId)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(brand);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { brandId } = await context.params;
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { data: brand, error } = await supabase
    .from('brands')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', brandId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(brand);
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { brandId } = await context.params;
  const supabase = await createServerSupabase();

  const { error } = await supabase.from('brands').delete().eq('id', brandId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}

// Upload logo
export async function PUT(request: NextRequest, context: RouteContext) {
  const { brandId } = await context.params;
  const supabase = await createServerSupabase();

  const formData = await request.formData();
  const file = formData.get('logo') as File;
  if (!file) return NextResponse.json({ error: 'logo file is required' }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `brands/${brandId}/logo.png`;

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: true });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: brand, error } = await supabase
    .from('brands')
    .update({ logo_storage_path: storagePath, updated_at: new Date().toISOString() })
    .eq('id', brandId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(brand);
}

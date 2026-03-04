import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: swatches, error } = await supabase
    .from('swatches')
    .select('*')
    .eq('project_id', id)
    .order('display_order', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(swatches);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const formData = await request.formData();
  const file = formData.get('file') as File;
  const name = (formData.get('name') as string) || file?.name?.replace(/\.[^.]+$/, '') || 'Sin nombre';
  const skuSuffix = formData.get('sku_suffix') as string | null;
  const colorDescription = formData.get('color_description') as string | null;

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const fileExt = file.name.split('.').pop();
  const fileName = `${crypto.randomUUID()}.${fileExt}`;
  const storagePath = `projects/${id}/swatches/${fileName}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Get current max display_order
  const { data: existing } = await supabase
    .from('swatches')
    .select('display_order')
    .eq('project_id', id)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  const { data: swatch, error: insertError } = await supabase
    .from('swatches')
    .insert({
      project_id: id,
      name,
      sku_suffix: skuSuffix || null,
      color_description: colorDescription || null,
      storage_path: storagePath,
      display_order: nextOrder,
      file_size_kb: Math.round(file.size / 1024),
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(swatch, { status: 201 });
}

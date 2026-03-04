import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: heroes, error } = await supabase
    .from('hero_shots')
    .select('*')
    .eq('project_id', id)
    .order('display_order', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(heroes);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const formData = await request.formData();
  const file = formData.get('file') as File;
  const shotType = (formData.get('shot_type') as string) || 'main';

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const fileExt = file.name.split('.').pop();
  const fileName = `${crypto.randomUUID()}.${fileExt}`;
  const storagePath = `projects/${id}/heroes/${fileName}`;

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
    .from('hero_shots')
    .select('display_order')
    .eq('project_id', id)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  const { data: hero, error: insertError } = await supabase
    .from('hero_shots')
    .insert({
      project_id: id,
      filename: file.name,
      storage_path: storagePath,
      shot_type: shotType,
      display_order: nextOrder,
      file_size_kb: Math.round(file.size / 1024),
      mime_type: file.type,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(hero, { status: 201 });
}

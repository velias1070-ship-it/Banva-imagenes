import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

// GET — list all images for a swatch
export async function GET(_request: NextRequest, context: RouteContext) {
  const { swatchId } = await context.params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('swatch_images')
    .select('*')
    .eq('swatch_id', swatchId)
    .order('display_order');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

// POST — upload a new reference image for a swatch
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId } = await context.params;
  const supabase = createAdminClient();

  const formData = await request.formData();
  const file = formData.get('file') as File;
  const label = (formData.get('label') as string) || '';

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  // Get next display_order
  const { data: existing } = await supabase
    .from('swatch_images')
    .select('display_order')
    .eq('swatch_id', swatchId)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  // Upload file
  const ext = file.name.split('.').pop() || 'jpg';
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const storagePath = `projects/${projectId}/swatches/${swatchId}/${fileName}`;

  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Insert record
  const { data: image, error: insertError } = await supabase
    .from('swatch_images')
    .insert({
      swatch_id: swatchId,
      storage_path: storagePath,
      label,
      file_size_kb: Math.round(file.size / 1024),
      display_order: nextOrder,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(image, { status: 201 });
}

// DELETE — remove a swatch image by id (passed as query param)
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { swatchId } = await context.params;
  const supabase = createAdminClient();

  const imageId = request.nextUrl.searchParams.get('imageId');
  if (!imageId) {
    return NextResponse.json({ error: 'imageId query param required' }, { status: 400 });
  }

  // Get storage path
  const { data: image } = await supabase
    .from('swatch_images')
    .select('storage_path')
    .eq('id', imageId)
    .eq('swatch_id', swatchId)
    .single();

  if (image?.storage_path) {
    await supabase.storage.from('images').remove([image.storage_path]);
  }

  await supabase.from('swatch_images').delete().eq('id', imageId);

  return NextResponse.json({ success: true });
}

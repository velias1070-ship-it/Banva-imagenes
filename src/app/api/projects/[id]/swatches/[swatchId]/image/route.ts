import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

/**
 * PUT — Replace swatch image with a new upload.
 * Deletes the old image from storage and uploads the new one.
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const { id: projectId, swatchId } = await context.params;
  const supabase = createAdminClient();

  const formData = await request.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  // Get current swatch
  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, storage_path')
    .eq('id', swatchId)
    .eq('project_id', projectId)
    .single();

  if (!swatch) {
    return NextResponse.json({ error: 'Swatch not found' }, { status: 404 });
  }

  // Delete old image if exists
  if (swatch.storage_path) {
    await supabase.storage.from('images').remove([swatch.storage_path]);
  }

  // Upload new image
  const fileExt = file.name.split('.').pop() || 'jpg';
  const fileName = `${crypto.randomUUID()}.${fileExt}`;
  const storagePath = `projects/${projectId}/swatches/${fileName}`;

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

  // Update swatch record
  const { data: updated, error: updateError } = await supabase
    .from('swatches')
    .update({
      storage_path: storagePath,
      file_size_kb: Math.round(file.size / 1024),
    })
    .eq('id', swatchId)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json(updated);
}

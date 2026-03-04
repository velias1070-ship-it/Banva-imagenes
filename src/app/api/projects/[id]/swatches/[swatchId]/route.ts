import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ id: string; swatchId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { swatchId } = await context.params;
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { data: swatch, error } = await supabase
    .from('swatches')
    .update(body)
    .eq('id', swatchId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(swatch);
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { swatchId } = await context.params;
  const supabase = await createServerSupabase();

  // Get storage path before deleting
  const { data: swatch } = await supabase
    .from('swatches')
    .select('storage_path')
    .eq('id', swatchId)
    .single();

  if (swatch) {
    await supabase.storage.from('images').remove([swatch.storage_path]);
  }

  const { error } = await supabase
    .from('swatches')
    .delete()
    .eq('id', swatchId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

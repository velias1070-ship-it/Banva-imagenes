import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteContext {
  params: Promise<{ id: string; heroId: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { heroId } = await context.params;
  const supabase = createAdminClient();

  // Get storage path before deleting
  const { data: hero } = await supabase
    .from('hero_shots')
    .select('storage_path')
    .eq('id', heroId)
    .single();

  if (!hero) {
    return NextResponse.json({ error: 'Hero not found' }, { status: 404 });
  }

  // Delete from storage
  if (hero.storage_path) {
    const { error: storageErr } = await supabase.storage.from('images').remove([hero.storage_path]);
    if (storageErr) {
      console.error('[heroes] Storage delete failed:', storageErr.message);
    }
  }

  // Delete from DB
  const { error } = await supabase
    .from('hero_shots')
    .delete()
    .eq('id', heroId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

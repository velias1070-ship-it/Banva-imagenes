import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ id: string; heroId: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { heroId } = await context.params;
  const supabase = await createServerSupabase();

  // Get storage path before deleting
  const { data: hero } = await supabase
    .from('hero_shots')
    .select('storage_path')
    .eq('id', heroId)
    .single();

  if (hero) {
    await supabase.storage.from('images').remove([hero.storage_path]);
  }

  const { error } = await supabase
    .from('hero_shots')
    .delete()
    .eq('id', heroId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

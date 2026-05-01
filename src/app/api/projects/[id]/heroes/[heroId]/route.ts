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

  // Delete associated generation jobs first (FK constraint)
  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select('id, output_storage_path')
    .eq('hero_shot_id', heroId);

  if (jobs?.length) {
    // Delete generated images from storage
    const generatedPaths = jobs
      .map(j => j.output_storage_path)
      .filter(Boolean) as string[];
    if (generatedPaths.length) {
      await supabase.storage.from('images').remove(generatedPaths);
    }
    // Delete jobs
    await supabase
      .from('generation_jobs')
      .delete()
      .eq('hero_shot_id', heroId);
  }

  // Delete hero from storage
  if (hero.storage_path) {
    const { error: storageErr } = await supabase.storage.from('images').remove([hero.storage_path]);
    if (storageErr) {
      console.error('[heroes] Storage delete failed:', storageErr.message);
    }
  }

  // Delete hero from DB
  const { error } = await supabase
    .from('hero_shots')
    .delete()
    .eq('id', heroId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { heroId } = await context.params;
  const supabase = createAdminClient();
  const body = await request.json().catch(() => ({}));

  const update: Record<string, unknown> = {};
  if ('applies_to_designs' in body) {
    update.applies_to_designs =
      Array.isArray(body.applies_to_designs) && body.applies_to_designs.length > 0
        ? body.applies_to_designs
        : null;
  }
  if ('applies_to_sizes' in body) {
    update.applies_to_sizes =
      Array.isArray(body.applies_to_sizes) && body.applies_to_sizes.length > 0
        ? body.applies_to_sizes
        : null;
  }
  if ('slot_position' in body) {
    update.slot_position =
      typeof body.slot_position === 'number' && body.slot_position >= 1
        ? Math.floor(body.slot_position)
        : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('hero_shots')
    .update(update)
    .eq('id', heroId)
    .select('id, applies_to_designs, applies_to_sizes, slot_position')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

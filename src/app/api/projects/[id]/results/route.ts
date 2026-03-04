import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createAdminClient();

  // Get ALL batches for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', id);

  if (!batches?.length) {
    return NextResponse.json([]);
  }

  const batchIds = batches.map((b) => b.id);

  const { data: jobs, error } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(filename, shot_type, storage_path),
      swatch:swatches(name, color_description, storage_path)
    `)
    .in('batch_id', batchIds)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(jobs || []);
}

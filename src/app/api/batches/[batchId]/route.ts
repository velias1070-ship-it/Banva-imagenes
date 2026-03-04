import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;
  const supabase = await createServerSupabase();

  const { data: batch, error } = await supabase
    .from('generation_batches')
    .select('*')
    .eq('id', batchId)
    .single();

  if (error || !batch) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  }

  return NextResponse.json(batch);
}

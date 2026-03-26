import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  const batchId = request.nextUrl.searchParams.get('id');
  if (!batchId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createAdminClient();

  const { data: batch } = await supabase
    .from('generation_batches')
    .select('id, status, project_id, total_combinations, completed_count, approved_count, flagged_count, error_count')
    .eq('id', batchId)
    .single();

  const { data: pendingJobs } = await supabase
    .from('generation_jobs')
    .select('id, status, attempt, error_message, updated_at')
    .eq('batch_id', batchId)
    .eq('status', 'pending')
    .limit(5);

  return NextResponse.json({ batch, pending_sample: pendingJobs });
}

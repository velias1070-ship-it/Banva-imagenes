/**
 * POST /api/admin/performance/refresh
 * Calls refresh_model_performance() RPC.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function POST() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AdminAuthError) return NextResponse.json({ error: err.reason }, { status: 401 });
    throw err;
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await supabase.rpc('refresh_model_performance');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, refreshedAt: new Date().toISOString() });
}

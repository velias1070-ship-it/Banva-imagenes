/**
 * GET /api/admin/whoami
 * Lightweight admin probe used by the sidebar to decide whether to render
 * the Admin nav entry. Returns { isAdmin: boolean } — never 401, so the
 * client can fire-and-forget without surfacing errors.
 */
import { NextResponse } from 'next/server';
import { getAdminContext } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = await getAdminContext();
  return NextResponse.json({ isAdmin: !!ctx, email: ctx?.email || null });
}

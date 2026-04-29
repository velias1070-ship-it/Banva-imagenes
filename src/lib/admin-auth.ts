/**
 * Admin auth helpers.
 *
 * Authorization model: a user is admin iff they have a Supabase auth
 * session AND their email appears in the ADMIN_EMAILS env var (csv).
 *
 * The Supabase session is established via magic-link sign-in at /login.
 * Pages under /admin/* read this helper to gate access; API routes
 * call requireAdmin() which throws → 401 if not authorized.
 */

import { createServerSupabase } from './supabase/server';

export function getAdminEmailAllowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface AdminContext {
  email: string;
  userId: string;
}

export async function getAdminContext(): Promise<AdminContext | null> {
  // Test-only bypass. Production never sets ADMIN_TEST_BYPASS, and the
  // process.env.NODE_ENV check ensures this is dead code in a built
  // production bundle.
  if (process.env.NODE_ENV !== 'production' && process.env.ADMIN_TEST_BYPASS === '1') {
    return { email: 'test@admin.local', userId: 'test-user' };
  }
  try {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return null;
    const allow = getAdminEmailAllowlist();
    if (!allow.has(user.email.toLowerCase())) return null;
    return { email: user.email, userId: user.id };
  } catch {
    // No request context (e.g. unit tests calling the handler directly,
    // or Supabase not configured). Treat as unauthenticated.
    return null;
  }
}

export async function requireAdmin(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) {
    throw new AdminAuthError('forbidden');
  }
  return ctx;
}

export class AdminAuthError extends Error {
  constructor(public reason: 'forbidden' | 'unauthenticated') {
    super(`admin auth: ${reason}`);
  }
}

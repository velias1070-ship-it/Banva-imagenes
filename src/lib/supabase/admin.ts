import { createClient } from '@supabase/supabase-js';

// Service role client — for serverless route handlers and cron jobs.
// NEVER expose this on the client side.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

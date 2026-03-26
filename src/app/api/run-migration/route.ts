import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Temporary endpoint — run the swatch_images migration
// DELETE THIS FILE after running once
export async function POST() {
  const supabase = createAdminClient();

  const sql = `
    CREATE TABLE IF NOT EXISTS swatch_images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      swatch_id UUID NOT NULL REFERENCES swatches(id) ON DELETE CASCADE,
      storage_path TEXT NOT NULL,
      label TEXT DEFAULT '',
      file_size_kb INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_swatch_images_swatch ON swatch_images(swatch_id);
  `;

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql }).single();

  if (error) {
    // Fallback: try direct table creation via Supabase client
    // The RPC might not exist, so try a simpler approach
    const { error: createError } = await supabase.from('swatch_images').select('id').limit(1);

    if (createError?.message?.includes('does not exist')) {
      return NextResponse.json({
        error: 'Table does not exist and cannot run raw SQL via API. Please run the migration in Supabase SQL Editor.',
        sql_to_run: sql,
      }, { status: 500 });
    }

    // Table already exists
    return NextResponse.json({ status: 'table_already_exists' });
  }

  return NextResponse.json({ status: 'migration_complete' });
}

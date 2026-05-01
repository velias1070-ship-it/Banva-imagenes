import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SlotPayload {
  position: number;
  name: string;
  expected_shot_type?: string | null;
  size_dependent?: boolean;
  notes?: string | null;
}

// GET /api/projects/[id]/slots — lista los slots del proyecto
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('project_image_slots')
    .select('*')
    .eq('project_id', id)
    .order('position');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

// POST /api/projects/[id]/slots
//   body: { slots: [{ position, name, expected_shot_type?, size_dependent?, notes? }, ...] }
//   reemplaza la definicion completa de slots del proyecto (upsert + delete missing)
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const incoming: SlotPayload[] = Array.isArray(body.slots) ? body.slots : [];

  const supabase = createAdminClient();

  // Validar
  const positions = new Set<number>();
  for (const s of incoming) {
    if (!Number.isInteger(s.position) || s.position < 1) {
      return NextResponse.json({ error: 'position debe ser entero >= 1' }, { status: 400 });
    }
    if (positions.has(s.position)) {
      return NextResponse.json({ error: `position ${s.position} duplicada` }, { status: 400 });
    }
    positions.add(s.position);
    if (!s.name?.trim()) {
      return NextResponse.json({ error: 'name requerido' }, { status: 400 });
    }
  }

  // Upsert
  const rows = incoming.map((s) => ({
    project_id: id,
    position: s.position,
    name: s.name.trim(),
    expected_shot_type: s.expected_shot_type ?? null,
    size_dependent: !!s.size_dependent,
    notes: s.notes ?? null,
    updated_at: new Date().toISOString(),
  }));

  const { error: upErr } = await supabase
    .from('project_image_slots')
    .upsert(rows, { onConflict: 'project_id,position' });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // Borrar los que ya no estan
  const keepPositions = Array.from(positions);
  if (keepPositions.length > 0) {
    await supabase
      .from('project_image_slots')
      .delete()
      .eq('project_id', id)
      .not('position', 'in', `(${keepPositions.join(',')})`);
  } else {
    await supabase.from('project_image_slots').delete().eq('project_id', id);
  }

  const { data: fresh } = await supabase
    .from('project_image_slots')
    .select('*')
    .eq('project_id', id)
    .order('position');

  return NextResponse.json(fresh || []);
}

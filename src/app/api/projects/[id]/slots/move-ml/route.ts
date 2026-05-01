import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface Move {
  swatch_id: string;
  from_position: number;
  to_position: number;
}

interface MoveBody {
  moves: Move[];
}

// POST /api/projects/[id]/slots/move-ml
//
// Reasigna la posicion (slot) de fotos en swatch_ml_pictures.
// Si el destino esta ocupado para el mismo swatch, hace SWAP automatico.
// Si esta vacio, solo updatea position.
//
// Notas:
// - Solo afecta cache ML local (swatch_ml_pictures), NO toca la publicacion en ML.
// - El swap usa una posicion temporal alta (9999) para evitar violar el unique
//   index (swatch_id, position) durante la transicion.
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const body: MoveBody = await req.json().catch(() => ({ moves: [] }));
  const moves = Array.isArray(body.moves) ? body.moves : [];
  if (moves.length === 0) {
    return NextResponse.json({ error: 'moves vacio' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Validar que todos los swatches pertenezcan al proyecto
  const swatchIds = Array.from(new Set(moves.map((m) => m.swatch_id)));
  const { data: ownedSwatches } = await supabase
    .from('swatches')
    .select('id')
    .eq('project_id', projectId)
    .in('id', swatchIds);
  const ownedSet = new Set((ownedSwatches || []).map((s) => s.id));
  const unauthorized = swatchIds.filter((id) => !ownedSet.has(id));
  if (unauthorized.length > 0) {
    return NextResponse.json(
      { error: `swatches no pertenecen al proyecto: ${unauthorized.join(', ')}` },
      { status: 403 }
    );
  }

  let moved = 0;
  let swapped = 0;
  const errors: string[] = [];

  for (const m of moves) {
    if (m.from_position === m.to_position) continue;
    if (!Number.isInteger(m.to_position) || m.to_position < 1) {
      errors.push(`${m.swatch_id}: to_position invalido (${m.to_position})`);
      continue;
    }

    // Cargar la celda origen
    const { data: src } = await supabase
      .from('swatch_ml_pictures')
      .select('id')
      .eq('swatch_id', m.swatch_id)
      .eq('position', m.from_position)
      .maybeSingle();
    if (!src) {
      errors.push(`${m.swatch_id} pos ${m.from_position}: no existe en cache`);
      continue;
    }

    // Cargar la celda destino (puede o no existir)
    const { data: dst } = await supabase
      .from('swatch_ml_pictures')
      .select('id')
      .eq('swatch_id', m.swatch_id)
      .eq('position', m.to_position)
      .maybeSingle();

    if (!dst) {
      // Slot libre — update directo
      const { error } = await supabase
        .from('swatch_ml_pictures')
        .update({ position: m.to_position })
        .eq('id', src.id);
      if (error) errors.push(`${m.swatch_id}: ${error.message}`);
      else moved++;
    } else {
      // SWAP via posicion temporal (9999 + offset random) para evitar conflicto
      // con el unique index (swatch_id, position) durante la transicion.
      const tmp = 9000 + Math.floor(Math.random() * 999);
      const { error: e1 } = await supabase
        .from('swatch_ml_pictures')
        .update({ position: tmp })
        .eq('id', src.id);
      if (e1) {
        errors.push(`${m.swatch_id} swap step1: ${e1.message}`);
        continue;
      }
      const { error: e2 } = await supabase
        .from('swatch_ml_pictures')
        .update({ position: m.from_position })
        .eq('id', dst.id);
      if (e2) {
        // rollback parcial
        await supabase
          .from('swatch_ml_pictures')
          .update({ position: m.from_position })
          .eq('id', src.id);
        errors.push(`${m.swatch_id} swap step2: ${e2.message}`);
        continue;
      }
      const { error: e3 } = await supabase
        .from('swatch_ml_pictures')
        .update({ position: m.to_position })
        .eq('id', src.id);
      if (e3) {
        errors.push(`${m.swatch_id} swap step3: ${e3.message}`);
        continue;
      }
      swapped++;
    }
  }

  return NextResponse.json({
    ok: true,
    moved,
    swapped,
    errors: errors.slice(0, 20),
    error_count: errors.length,
  });
}

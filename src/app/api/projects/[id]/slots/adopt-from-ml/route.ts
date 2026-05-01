import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { randomUUID } from 'crypto';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface AdoptTarget {
  swatch_id: string;
  position: number;
}

interface AdoptBody {
  // Si se envia explicit, solo se adoptan esos. Si scope='only_ml', se adoptan
  // TODOS los slots que tienen foto en ML cache pero ningun job aprobado en el
  // sistema para ese (swatch, slot).
  targets?: AdoptTarget[];
  scope?: 'only_ml';
  overwrite?: boolean; // si true, tambien adopta drift (ML sobre sistema)
}

// POST /api/projects/[id]/slots/adopt-from-ml
//
// Toma fotos del cache de ML (swatch_ml_pictures) y las registra como jobs
// aprobados en banva-app. No descarga binarios, no llama Gemini — solo crea
// generation_jobs apuntando a la URL de ML directamente. Asi quedan visibles
// en /results y /slots, y se pueden replicar a hermanos.
//
// Requiere que el slot tenga un hero asignado (slot_position en hero_shots).
// Sin eso, no hay forma de saber qué hero asociar al job clonado.
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const body: AdoptBody = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  // Build the list of (swatch_id, position) to adopt
  const requestedExplicit = Array.isArray(body.targets) && body.targets.length > 0;
  const overwrite = !!body.overwrite;

  // Heroes-by-slot map: cada slot tiene UN hero canonico (el ultimo asignado).
  const { data: heroes } = await supabase
    .from('hero_shots')
    .select('id, slot_position')
    .eq('project_id', projectId)
    .not('slot_position', 'is', null);
  const heroBySlot = new Map<number, string>();
  for (const h of heroes || []) {
    if (h.slot_position) heroBySlot.set(h.slot_position, h.id);
  }
  if (heroBySlot.size === 0) {
    return NextResponse.json(
      { error: 'No hay heroes asignados a slots todavia. Asigná al menos uno.' },
      { status: 400 }
    );
  }

  // Cargar todo el cache ML del proyecto + jobs aprobados existentes
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id')
    .eq('project_id', projectId);
  const swatchIds = (swatches || []).map((s) => s.id);
  if (swatchIds.length === 0) return NextResponse.json({ ok: true, adopted: 0 });

  const [{ data: mlCache }, { data: batches }] = await Promise.all([
    supabase
      .from('swatch_ml_pictures')
      .select('swatch_id, position, ml_picture_id, ml_picture_url')
      .in('swatch_id', swatchIds),
    supabase.from('generation_batches').select('id').eq('project_id', projectId),
  ]);
  const batchIds = (batches || []).map((b) => b.id);

  // Cuales (swatch, slot) ya tienen job aprobado del sistema?
  const existing = new Set<string>(); // `${swatch_id}|${slot_pos}`
  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('swatch_id, hero_shot_id')
      .in('batch_id', batchIds)
      .eq('status', 'approved')
      .not('output_storage_path', 'is', null);
    for (const j of jobs || []) {
      if (!j.swatch_id || !j.hero_shot_id) continue;
      // hero → slot lookup
      const heroSlot = Array.from(heroBySlot.entries()).find(([, hid]) => hid === j.hero_shot_id)?.[0];
      if (heroSlot) existing.add(`${j.swatch_id}|${heroSlot}`);
    }
  }

  // Filtrar el cache para solo lo adoptable
  const candidates = (mlCache || []).filter((m) => {
    if (!heroBySlot.has(m.position)) return false; // no hay hero asignado a este slot
    if (requestedExplicit) {
      return body.targets!.some(
        (t) => t.swatch_id === m.swatch_id && t.position === m.position
      );
    }
    // scope='only_ml' (default): solo adoptar si NO hay sistema ya
    // overwrite: ignorar el filtro y adoptar todos los del cache
    if (overwrite) return true;
    return !existing.has(`${m.swatch_id}|${m.position}`);
  });

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, adopted: 0, message: 'Nada para adoptar' });
  }

  // Crear un batch contenedor
  const { data: batch, error: batchErr } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'completed',
      total_combinations: candidates.length,
      completed_count: candidates.length,
      approved_count: candidates.length,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: 0,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (batchErr || !batch) {
    return NextResponse.json({ error: batchErr?.message || 'no se pudo crear batch' }, { status: 500 });
  }

  // Para cada candidate: descargar la URL de ML y subir al storage propio.
  // Asi el job queda con un output_storage_path real que vive en banva-app
  // (no depende de la URL de ML que puede expirar/cambiar).
  const newJobs: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const c of candidates) {
    const heroId = heroBySlot.get(c.position)!;
    try {
      const imgRes = await fetch(c.ml_picture_url);
      if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ext = c.ml_picture_url.toLowerCase().includes('.png') ? 'png' : 'jpg';
      const jobId = randomUUID();
      const path = `projects/${projectId}/generated/adopted_${jobId}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('images')
        .upload(path, buf, {
          contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
          upsert: true,
        });
      if (upErr) throw new Error(`upload: ${upErr.message}`);
      newJobs.push({
        id: jobId,
        batch_id: batch.id,
        hero_shot_id: heroId,
        swatch_id: c.swatch_id,
        status: 'approved',
        attempt: 0,
        output_storage_path: path,
        prompt_metadata: {
          adopted_from_ml: true,
          ml_picture_id: c.ml_picture_id,
          ml_picture_url: c.ml_picture_url,
          slot_position: c.position,
        },
      });
    } catch (err) {
      errors.push(`${c.swatch_id}|${c.position}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (newJobs.length === 0) {
    await supabase.from('generation_batches').delete().eq('id', batch.id);
    return NextResponse.json({ error: 'No se pudo adoptar ninguna', errors }, { status: 500 });
  }

  const { error: insErr } = await supabase.from('generation_jobs').insert(newJobs);
  if (insErr) {
    await supabase.from('generation_batches').delete().eq('id', batch.id);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // Actualizar el contador del batch al numero real adoptado
  if (newJobs.length !== candidates.length) {
    await supabase
      .from('generation_batches')
      .update({
        total_combinations: newJobs.length,
        completed_count: newJobs.length,
        approved_count: newJobs.length,
      })
      .eq('id', batch.id);
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    adopted: newJobs.length,
    errors: errors.slice(0, 10),
    error_count: errors.length,
    batch_id: batch.id,
  });
}

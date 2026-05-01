import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { type ProjectVariant } from '@/lib/sku-parser';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface Body {
  // Replicar dentro de UNA columna (slot_position).
  position: number;
  // Si true, sobreescribe siblings que ya tienen contenido (no recomendado).
  // Default false: solo cubre celdas vacias.
  overwrite?: boolean;
}

// POST /api/projects/[id]/slots/replicate-siblings
//
// Para una columna (slot_position), toma cada celda con job aprobado y
// clona el output_storage_path a los swatches hermanos del mismo design
// (color_slug) que tengan la celda vacia. Util despues de generar con
// dedup en slots no size-dependent.
//
// No descarga ni regenera nada — solo crea generation_jobs nuevos
// apuntando al mismo storage_path. Costo Gemini: $0.
//
// Si el slot es size_dependent, no hace nada (las celdas son independientes
// por tamano y replicar seria incorrecto).
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const body: Body = await req.json().catch(() => ({}));
  const position = body.position;
  if (typeof position !== 'number') {
    return NextResponse.json({ error: 'position requerido' }, { status: 400 });
  }
  const overwrite = !!body.overwrite;
  const supabase = createAdminClient();

  // 1. Validar que el slot exista y NO sea size_dependent
  const { data: slot } = await supabase
    .from('project_image_slots')
    .select('position, size_dependent')
    .eq('project_id', projectId)
    .eq('position', position)
    .maybeSingle();

  if (!slot) return NextResponse.json({ error: 'slot no existe' }, { status: 404 });
  if (slot.size_dependent) {
    return NextResponse.json(
      { error: 'slot es por-tamano — no se puede replicar a hermanos (cada tamano es independiente)' },
      { status: 400 }
    );
  }

  // 2. Cargar swatches + variantes (para color_slug)
  const [{ data: project }, { data: swatches }, { data: heroes }, { data: batches }] = await Promise.all([
    supabase.from('projects').select('id, metadata').eq('id', projectId).single(),
    supabase
      .from('swatches')
      .select('id, sku_suffix, display_order')
      .eq('project_id', projectId)
      .order('display_order'),
    supabase
      .from('hero_shots')
      .select('id, slot_position')
      .eq('project_id', projectId)
      .eq('slot_position', position),
    supabase.from('generation_batches').select('id').eq('project_id', projectId),
  ]);

  if (!project) return NextResponse.json({ error: 'proyecto no existe' }, { status: 404 });

  const variantes: ProjectVariant[] = ((project.metadata as { variantes?: ProjectVariant[] } | null)?.variantes) || [];
  const variantBySku = new Map<string, ProjectVariant>();
  for (const v of variantes) {
    if (v.sku) variantBySku.set(v.sku.toUpperCase(), v);
  }

  const designOf = (sId: string): string | null => {
    const s = (swatches || []).find((x) => x.id === sId);
    if (!s) return null;
    const v = variantBySku.get((s.sku_suffix || '').toUpperCase());
    return v?.color_slug || null;
  };

  // 3. Cargar jobs existentes en esta columna
  const heroIds = (heroes || []).map((h) => h.id);
  if (heroIds.length === 0) {
    return NextResponse.json({ error: 'sin heroes asignados a este slot' }, { status: 400 });
  }
  const batchIds = (batches || []).map((b) => b.id);
  if (batchIds.length === 0) {
    return NextResponse.json({ ok: true, replicated: 0, message: 'sin batches todavia' });
  }

  type ApprovedJob = {
    id: string;
    swatch_id: string;
    hero_shot_id: string;
    status: string;
    output_storage_path: string;
    created_at: string;
    prompt_metadata: Record<string, unknown> | null;
  };

  const { data: jobsRaw } = await supabase
    .from('generation_jobs')
    .select('id, swatch_id, hero_shot_id, status, output_storage_path, created_at, prompt_metadata')
    .in('batch_id', batchIds)
    .in('hero_shot_id', heroIds)
    .eq('status', 'approved')
    .not('output_storage_path', 'is', null);

  const jobs: ApprovedJob[] = (jobsRaw || []).filter(
    (j): j is ApprovedJob => !!j.swatch_id && !!j.hero_shot_id && !!j.output_storage_path
  ) as ApprovedJob[];

  // Por (swatch_id) tomar el job mas reciente
  const latestBySwatch = new Map<string, ApprovedJob>();
  for (const j of jobs) {
    const cur = latestBySwatch.get(j.swatch_id);
    if (!cur || j.created_at > cur.created_at) latestBySwatch.set(j.swatch_id, j);
  }

  // Source group: design → un job representante
  const sourceByDesign = new Map<string, ApprovedJob>();
  for (const [swatchId, job] of latestBySwatch.entries()) {
    const d = designOf(swatchId);
    if (!d) continue;
    const existing = sourceByDesign.get(d);
    if (!existing || job.created_at > existing.created_at) sourceByDesign.set(d, job);
  }

  // 4. Targets: swatches sin job (o con job si overwrite) cuya design tenga source
  const occupied = new Set(latestBySwatch.keys());
  const replicas: Array<{
    batch_id: string;
    hero_shot_id: string;
    swatch_id: string;
    status: string;
    attempt: number;
    output_storage_path: string;
    prompt_metadata: Record<string, unknown>;
  }> = [];

  for (const swatch of swatches || []) {
    const isOccupied = occupied.has(swatch.id);
    if (isOccupied && !overwrite) continue;
    const design = designOf(swatch.id);
    if (!design) continue;
    const source = sourceByDesign.get(design);
    if (!source) continue;
    if (source.swatch_id === swatch.id) continue; // no replicarse a si mismo
    replicas.push({
      batch_id: '', // se setea despues
      hero_shot_id: source.hero_shot_id,
      swatch_id: swatch.id,
      status: 'approved',
      attempt: 0,
      output_storage_path: source.output_storage_path,
      prompt_metadata: {
        replicated_from_swatch_id: source.swatch_id,
        replicated_from_job_id: source.id,
        slot_position: position,
        sibling_replication: true,
      },
    });
  }

  if (replicas.length === 0) {
    return NextResponse.json({
      ok: true,
      replicated: 0,
      sources: sourceByDesign.size,
      message: 'no hay hermanos para cubrir',
    });
  }

  // 5. Crear batch contenedor
  const { data: batch, error: batchErr } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'completed',
      total_combinations: replicas.length,
      completed_count: replicas.length,
      approved_count: replicas.length,
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

  const rows = replicas.map((r) => ({ ...r, batch_id: batch.id }));
  const { error: insErr } = await supabase.from('generation_jobs').insert(rows);
  if (insErr) {
    await supabase.from('generation_batches').delete().eq('id', batch.id);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    replicated: replicas.length,
    sources: sourceByDesign.size,
    batch_id: batch.id,
  });
}

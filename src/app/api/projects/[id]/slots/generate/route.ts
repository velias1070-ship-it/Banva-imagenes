import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_PER_IMAGE_USD } from '@/lib/constants';
import { resolveHeroForVariant, type ProjectVariant } from '@/lib/sku-parser';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CellTarget {
  swatch_id: string;
  position: number;
}

interface GenerateBody {
  // Si se pasa position: genera todas las celdas vacias de esa columna.
  // Si se pasan cells: genera solo esas celdas (deben estar vacias).
  // Si no se pasa nada: error.
  position?: number;
  cells?: CellTarget[];
  // dry_run=true: no crea batch, solo devuelve el plan (cuantas celdas, cost)
  dry_run?: boolean;
}

interface PreviewItem {
  swatch_id: string;
  swatch_label: string;
  position: number;
  hero_id: string | null;
  hero_filename: string | null;
  reason_skipped?: string;
}

// Trigger del chain de process-next (mismo patron que /generate)
async function startBatchProcessing(batchId: string) {
  const supabase = createAdminClient();
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', started_at: new Date().toISOString() })
    .eq('id', batchId);

  const baseUrl =
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000';

  await fetch(`${baseUrl}/api/batches/${batchId}/process-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => {
    console.error('[slots/generate] Failed to trigger process-next:', err);
  });
}

// POST /api/projects/[id]/slots/generate
//
// Genera celdas vacias de la grilla usando los heroes asignados al slot.
// Para slots por-tamaño (multiple heroes en slot_position), usa el resolver
// para elegir el hero correcto segun el bed_size/design del swatch.
//
// Body:
//   { position: 3 }                          → genera columna entera
//   { cells: [{swatch_id, position}, ...] }  → genera celdas especificas
//   { position: 3, dry_run: true }           → preview (no crea batch)
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const body: GenerateBody = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  // 1. Resolver targets (que celdas queremos generar)
  let targets: CellTarget[] = [];
  if (Array.isArray(body.cells) && body.cells.length > 0) {
    targets = body.cells;
  } else if (typeof body.position === 'number') {
    // Cargar todos los swatches del proyecto y armar targets para esa columna
    const { data: swatches } = await supabase
      .from('swatches')
      .select('id')
      .eq('project_id', projectId);
    targets = (swatches || []).map((s) => ({ swatch_id: s.id, position: body.position! }));
  } else {
    return NextResponse.json({ error: 'falta position o cells' }, { status: 400 });
  }

  if (targets.length === 0) {
    return NextResponse.json({ error: 'sin targets' }, { status: 400 });
  }

  // 2. Cargar metadata necesaria
  const positions = Array.from(new Set(targets.map((t) => t.position)));
  const swatchIds = Array.from(new Set(targets.map((t) => t.swatch_id)));

  const [{ data: project }, { data: allSwatches }, { data: heroes }, { data: batches }, { data: slotsRows }] = await Promise.all([
    supabase.from('projects').select('id, metadata').eq('id', projectId).single(),
    // Cargamos TODOS los swatches del proyecto (no solo los targets) porque
    // necesitamos los hermanos de mismo design para dedup en slots non-size-dep.
    supabase
      .from('swatches')
      .select('id, name, sku_suffix, display_order')
      .eq('project_id', projectId),
    supabase
      .from('hero_shots')
      .select('id, filename, slot_position, display_order, applies_to_designs, applies_to_sizes')
      .eq('project_id', projectId)
      .in('slot_position', positions),
    supabase.from('generation_batches').select('id').eq('project_id', projectId),
    supabase
      .from('project_image_slots')
      .select('position, size_dependent')
      .eq('project_id', projectId)
      .in('position', positions),
  ]);

  const sizeDependentBySlot = new Map<number, boolean>(
    (slotsRows || []).map((s) => [s.position, !!s.size_dependent])
  );

  if (!project) {
    return NextResponse.json({ error: 'proyecto no existe' }, { status: 404 });
  }

  const variantes: ProjectVariant[] = ((project.metadata as { variantes?: ProjectVariant[] } | null)?.variantes) || [];
  const variantBySku = new Map<string, ProjectVariant>();
  for (const v of variantes) {
    if (v.sku) variantBySku.set(v.sku.toUpperCase(), v);
  }

  const swatchById = new Map((allSwatches || []).map((s) => [s.id, s]));

  // Heroes agrupados por slot_position
  const heroesBySlot = new Map<number, typeof heroes>();
  for (const h of heroes || []) {
    if (!h.slot_position) continue;
    if (!heroesBySlot.has(h.slot_position)) heroesBySlot.set(h.slot_position, []);
    heroesBySlot.get(h.slot_position)!.push(h);
  }

  // 3. Cargar celdas que ya tienen contenido (sistema aprobado/pending) para
  // saltarlas. Cargamos TODAS para que el dedup pueda chequear si algun hermano
  // del mismo design ya esta cubierto.
  const batchIds = (batches || []).map((b) => b.id);
  const occupied = new Set<string>(); // `${swatch_id}|${position}` con job
  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('swatch_id, hero_shot_id, status, output_storage_path')
      .in('batch_id', batchIds)
      .in('status', ['approved', 'pending', 'generating']);
    const heroSlotById = new Map((heroes || []).map((h) => [h.id, h.slot_position]));
    for (const j of jobs || []) {
      if (!j.swatch_id || !j.hero_shot_id) continue;
      const slotPos = heroSlotById.get(j.hero_shot_id);
      if (!slotPos) continue;
      if (j.status === 'approved' && !j.output_storage_path) continue;
      occupied.add(`${j.swatch_id}|${slotPos}`);
    }
  }

  // 3b. DEDUP para slots NO size-dependent: agrupar por DESIGN sin el tamaño.
  // Algunos proyectos legacy guardan color_slug INCLUYENDO bed_size
  // (e.g. "aba-estampado-1-plaza"), lo que rompe el dedup. Usamos
  // color+tipo como clave canonica y caemos a color_slug solo si no estan.
  function designKey(swatchId: string): string {
    const swatch = swatchById.get(swatchId);
    const sku = (swatch?.sku_suffix || '').toUpperCase();
    const v = variantBySku.get(sku);
    if (v?.color || v?.tipo) {
      return `${(v.color || '').trim().toLowerCase()}|${(v.tipo || '').trim().toLowerCase()}`;
    }
    // Fallback legacy: usar color_slug pero quitarle un sufijo que parezca tamaño
    // (e.g. "-1-plaza", "-1-5-plazas", "-2-plazas")
    if (v?.color_slug) {
      return v.color_slug.replace(/-(\d+(-\d+)?-plazas?)$/i, '');
    }
    return `__nodesign__${swatchId}`;
  }

  const dedupedTargets: CellTarget[] = [];
  const dedupedOut: PreviewItem[] = []; // items "siblings" que quedan para replicar luego
  const seenDesignSlot = new Set<string>(); // `${design}|${position}`

  for (const t of targets) {
    const slotIsSizeDep = sizeDependentBySlot.get(t.position) ?? false;
    if (slotIsSizeDep) {
      // Slot por-tamaño: cada celda es independiente (no dedup)
      dedupedTargets.push(t);
      continue;
    }

    const swatch = swatchById.get(t.swatch_id);
    const sku = (swatch?.sku_suffix || '').toUpperCase();
    const variant = variantBySku.get(sku);
    const design = designKey(t.swatch_id);
    const groupKey = `${design}|${t.position}`;

    // Si algun swatch del mismo design ya tiene foto en este slot, esta
    // generacion se salta — basta con replicar despues.
    const designAlreadyCovered = (allSwatches || []).some((s) => {
      if (s.id === t.swatch_id) return false;
      const sDesign = designKey(s.id);
      if (sDesign !== design) return false;
      return occupied.has(`${s.id}|${t.position}`);
    });

    if (designAlreadyCovered) {
      const labelParts = [variant?.color, variant?.tipo, variant?.bed_size].filter(Boolean) as string[];
      dedupedOut.push({
        swatch_id: t.swatch_id,
        swatch_label: labelParts.length > 0 ? labelParts.join(' · ') : (swatch?.name || ''),
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: 'sibling de mismo design ya cubierto — usar Replicar a hermanos',
      });
      continue;
    }

    if (seenDesignSlot.has(groupKey)) {
      const labelParts = [variant?.color, variant?.tipo, variant?.bed_size].filter(Boolean) as string[];
      dedupedOut.push({
        swatch_id: t.swatch_id,
        swatch_label: labelParts.length > 0 ? labelParts.join(' · ') : (swatch?.name || ''),
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: 'dedup por design (slot no es por-tamaño) — replicar despues',
      });
      continue;
    }
    seenDesignSlot.add(groupKey);
    dedupedTargets.push(t);
  }

  // 4. Para cada target deduplicado: resolver hero y armar plan
  const plan: PreviewItem[] = [...dedupedOut];
  for (const t of dedupedTargets) {
    const swatch = swatchById.get(t.swatch_id);
    if (!swatch) {
      plan.push({
        swatch_id: t.swatch_id,
        swatch_label: '(swatch desconocido)',
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: 'swatch no pertenece al proyecto',
      });
      continue;
    }

    const sku = (swatch.sku_suffix || '').toUpperCase();
    const variant = variantBySku.get(sku);
    const labelParts = [variant?.color, variant?.tipo, variant?.bed_size].filter(Boolean) as string[];
    const label = labelParts.length > 0 ? labelParts.join(' · ') : swatch.name;

    if (occupied.has(`${t.swatch_id}|${t.position}`)) {
      plan.push({
        swatch_id: t.swatch_id,
        swatch_label: label,
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: 'ya tiene job aprobado o en cola',
      });
      continue;
    }

    const slotHeroes = heroesBySlot.get(t.position) || [];
    if (slotHeroes.length === 0) {
      plan.push({
        swatch_id: t.swatch_id,
        swatch_label: label,
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: 'sin hero asignado al slot',
      });
      continue;
    }

    // Resolver: usa applies_to_designs/sizes para elegir entre los heroes
    // del slot el que mejor matchea con esta variante.
    const design = variant?.color_slug || null;
    const size = variant?.bed_size || null;
    const resolved = resolveHeroForVariant(slotHeroes, design, size);

    if (!resolved) {
      plan.push({
        swatch_id: t.swatch_id,
        swatch_label: label,
        position: t.position,
        hero_id: null,
        hero_filename: null,
        reason_skipped: `ningun hero del slot aplica a (${design || '?'}, ${size || '?'})`,
      });
      continue;
    }

    plan.push({
      swatch_id: t.swatch_id,
      swatch_label: label,
      position: t.position,
      hero_id: resolved.hero.id,
      hero_filename: resolved.hero.filename,
    });
  }

  const generable = plan.filter((p) => p.hero_id);
  const skipped = plan.filter((p) => p.reason_skipped);
  const estimatedCost = generable.length * COST_PER_IMAGE_USD;

  const dedupSavings = dedupedOut.length;

  if (body.dry_run) {
    return NextResponse.json({
      dry_run: true,
      total_targets: targets.length,
      generable: generable.length,
      skipped_count: skipped.length,
      dedup_siblings: dedupSavings,
      estimated_cost_usd: estimatedCost,
      plan,
    });
  }

  if (generable.length === 0) {
    return NextResponse.json(
      {
        error: 'No hay nada para generar',
        skipped_count: skipped.length,
        skipped_examples: skipped.slice(0, 5),
      },
      { status: 400 }
    );
  }

  // 5. Crear batch + jobs
  const { data: batch, error: batchErr } = await supabase
    .from('generation_batches')
    .insert({
      project_id: projectId,
      status: 'pending',
      total_combinations: generable.length,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: estimatedCost,
    })
    .select()
    .single();

  if (batchErr || !batch) {
    return NextResponse.json({ error: batchErr?.message || 'no se pudo crear batch' }, { status: 500 });
  }

  const jobs = generable.map((p) => ({
    batch_id: batch.id,
    hero_shot_id: p.hero_id!,
    swatch_id: p.swatch_id,
    status: 'pending',
    attempt: 0,
    prompt_metadata: { triggered_from: 'slots_grid', target_slot_position: p.position },
  }));

  const { error: jobsErr } = await supabase.from('generation_jobs').insert(jobs);
  if (jobsErr) {
    await supabase.from('generation_batches').delete().eq('id', batch.id);
    return NextResponse.json({ error: jobsErr.message }, { status: 500 });
  }

  // 6. Disparar el chain
  after(async () => {
    try {
      await startBatchProcessing(batch.id);
    } catch (err) {
      console.error('[slots/generate] startBatchProcessing failed:', err);
    }
  });

  return NextResponse.json({
    ok: true,
    batch_id: batch.id,
    queued: generable.length,
    skipped_count: skipped.length,
    dedup_siblings: dedupSavings,
    estimated_cost_usd: estimatedCost,
  });
}

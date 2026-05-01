import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface VarianteMeta {
  sku?: string;
  color?: string;
  tipo?: string | null;
  bed_size?: string | null;
  label?: string;
  item_id?: string;
  permalink?: string;
}

interface CellSystem {
  job_id: string;
  url: string;
  status: string;
  hero_id: string | null;
  marked_done: boolean;
  created_at: string;
}

interface CellMl {
  ml_picture_id: string;
  url: string;
  fetched_at: string;
}

type CellStatus = 'match' | 'drift' | 'only_ml' | 'only_system' | 'empty';

interface Cell {
  swatch_id: string;
  position: number;
  system: CellSystem | null;
  ml: CellMl | null;
  status: CellStatus;
}

interface SwatchEntry {
  id: string;
  sku_suffix: string | null;
  name: string;
  storage_path: string;
  display_order: number;
  marked_done_at: string | null;
  color: string | null;
  tipo: string | null;
  bed_size: string | null;
  label: string;
  ml_item_id: string | null;
  ml_permalink: string | null;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/images`;

// GET /api/projects/[id]/slots/state — todo lo que la pagina /slots necesita
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id: projectId } = await ctx.params;
  const supabase = createAdminClient();

  const [{ data: project }, { data: slots }, { data: swatches }, { data: heroes }, { data: batches }] =
    await Promise.all([
      supabase.from('projects').select('id, metadata').eq('id', projectId).single(),
      supabase.from('project_image_slots').select('*').eq('project_id', projectId).order('position'),
      supabase
        .from('swatches')
        .select('id, name, sku_suffix, storage_path, display_order, marked_done_at')
        .eq('project_id', projectId)
        .order('display_order'),
      supabase
        .from('hero_shots')
        .select('id, slot_position, shot_type, display_order, applies_to_designs, applies_to_sizes')
        .eq('project_id', projectId),
      supabase.from('generation_batches').select('id').eq('project_id', projectId),
    ]);

  const variantes: VarianteMeta[] = ((project?.metadata as { variantes?: VarianteMeta[] } | null)?.variantes) || [];
  const variantBySku = new Map<string, VarianteMeta>();
  for (const v of variantes) {
    if (v.sku) variantBySku.set(v.sku.toUpperCase(), v);
  }

  const swatchEntries: SwatchEntry[] = (swatches || []).map((s) => {
    const sku = (s.sku_suffix || '').toUpperCase();
    const v = sku ? variantBySku.get(sku) : undefined;
    const labelParts = [v?.color, v?.tipo, v?.bed_size].filter(Boolean) as string[];
    return {
      id: s.id,
      sku_suffix: s.sku_suffix,
      name: s.name,
      storage_path: s.storage_path,
      display_order: s.display_order,
      marked_done_at: s.marked_done_at,
      color: v?.color || null,
      tipo: v?.tipo || null,
      bed_size: v?.bed_size || null,
      label: labelParts.length > 0 ? labelParts.join(' · ') : s.name,
      ml_item_id: v?.item_id || null,
      ml_permalink: v?.permalink || null,
    };
  });

  // Approved jobs (sistema) keyed by (swatch_id, slot_position)
  const heroById = new Map((heroes || []).map((h) => [h.id, h]));
  const batchIds = (batches || []).map((b) => b.id);
  let systemBySwatchSlot = new Map<string, CellSystem>();

  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('id, swatch_id, hero_shot_id, status, output_storage_path, created_at')
      .in('batch_id', batchIds)
      .eq('status', 'approved')
      .not('output_storage_path', 'is', null);

    // Para cada (swatch, slot) tomamos el job mas reciente
    const tmp = new Map<string, CellSystem>();
    for (const job of jobs || []) {
      if (!job.swatch_id || !job.hero_shot_id) continue;
      const hero = heroById.get(job.hero_shot_id);
      const slotPos = hero?.slot_position;
      if (!slotPos) continue; // sin slot canónico, no entra al pivot
      const key = `${job.swatch_id}|${slotPos}`;
      const existing = tmp.get(key);
      if (!existing || (job.created_at > existing.created_at)) {
        tmp.set(key, {
          job_id: job.id,
          url: `${STORAGE_BASE}/${job.output_storage_path}`,
          status: job.status,
          hero_id: job.hero_shot_id,
          marked_done: false,
          created_at: job.created_at,
        });
      }
    }
    systemBySwatchSlot = tmp;
  }

  // ML pictures cache keyed by (swatch_id, position)
  const swatchIdList = swatchEntries.map((s) => s.id);
  const mlBySwatchSlot = new Map<string, CellMl>();
  if (swatchIdList.length > 0) {
    const { data: mlPics } = await supabase
      .from('swatch_ml_pictures')
      .select('swatch_id, position, ml_picture_id, ml_picture_url, fetched_at')
      .in('swatch_id', swatchIdList);
    for (const p of mlPics || []) {
      mlBySwatchSlot.set(`${p.swatch_id}|${p.position}`, {
        ml_picture_id: p.ml_picture_id,
        url: p.ml_picture_url,
        fetched_at: p.fetched_at,
      });
    }
  }

  // Build cells: una por cada (swatch, slot)
  const cells: Cell[] = [];
  const slotList = slots || [];
  for (const swatch of swatchEntries) {
    for (const slot of slotList) {
      const key = `${swatch.id}|${slot.position}`;
      const sys = systemBySwatchSlot.get(key) || null;
      const ml = mlBySwatchSlot.get(key) || null;
      let status: CellStatus = 'empty';
      if (sys && ml) {
        // Match si la URL es la misma (o el path coincide). Heuristico — los
        // CDNs cambian dominios, asi que comparar fragmentos del id ayuda.
        const sysFile = sys.url.split('/').pop() || '';
        const mlFile = ml.url.split('/').pop() || '';
        status = sysFile && mlFile && sysFile === mlFile ? 'match' : 'drift';
      } else if (sys && !ml) {
        status = 'only_system';
      } else if (!sys && ml) {
        status = 'only_ml';
      }
      cells.push({ swatch_id: swatch.id, position: slot.position, system: sys, ml, status });
    }
  }

  return NextResponse.json({
    slots: slotList,
    swatches: swatchEntries,
    heroes: (heroes || []).map((h) => ({
      id: h.id,
      shot_type: h.shot_type,
      display_order: h.display_order,
      slot_position: h.slot_position,
      applies_to_designs: h.applies_to_designs,
      applies_to_sizes: h.applies_to_sizes,
    })),
    cells,
  });
}

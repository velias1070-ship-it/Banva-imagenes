import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 15;

/**
 * GET /api/search?q=roma+gris&status=approved
 *
 * Searches generated images by:
 * - SKU (swatch.sku_suffix)
 * - Color/variant name (swatch.name)
 * - Project name
 * - Shot type (hero_shot.shot_type)
 *
 * Optional filters:
 * - status: approved, flagged, retry, etc.
 * - project_id: limit to one project
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  const status = request.nextUrl.searchParams.get('status');
  const projectId = request.nextUrl.searchParams.get('project_id');

  if (!q && !status && !projectId) {
    return NextResponse.json({ error: 'Provide ?q= search term, ?status=, or ?project_id=' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  // Build query: jobs with relations
  let query = supabase
    .from('generation_jobs')
    .select(`
      id,
      status,
      attempt,
      output_storage_path,
      qa_score,
      created_at,
      updated_at,
      batch_id,
      swatch:swatches!inner(id, name, sku_suffix, color_description),
      hero_shot:hero_shots!inner(id, filename, shot_type)
    `)
    .not('output_storage_path', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (status) {
    query = query.eq('status', status);
  }

  if (projectId) {
    // Filter by project via batches
    const { data: batches } = await supabase
      .from('generation_batches')
      .select('id')
      .eq('project_id', projectId);

    if (batches?.length) {
      query = query.in('batch_id', batches.map((b) => b.id));
    } else {
      return NextResponse.json({ results: [], total: 0 });
    }
  }

  const { data: jobs, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Client-side filter by search term (across swatch name, sku, project)
  let results = jobs || [];

  if (q) {
    const terms = q.toLowerCase().split(/\s+/);

    // Get project names for matching
    const batchIds = [...new Set(results.map((j) => j.batch_id))];
    const { data: batchProjects } = await supabase
      .from('generation_batches')
      .select('id, project:projects!inner(id, name, slug, sku_base)')
      .in('id', batchIds.length > 0 ? batchIds : ['__none__']);

    const batchToProject = new Map(
      (batchProjects || []).map((bp) => {
        const proj = bp.project as unknown as { id: string; name: string; slug: string; sku_base: string | null };
        return [bp.id, proj];
      })
    );

    results = results.filter((job) => {
      const swatch = job.swatch as unknown as { name: string; sku_suffix: string | null; color_description: string | null };
      const hero = job.hero_shot as unknown as { shot_type: string; filename: string };
      const proj = batchToProject.get(job.batch_id);

      const searchable = [
        swatch?.name,
        swatch?.sku_suffix,
        swatch?.color_description,
        hero?.shot_type,
        hero?.filename,
        proj?.name,
        proj?.slug,
        proj?.sku_base,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return terms.every((term) => searchable.includes(term));
    });

    // Attach project info to results
    results = results.map((job) => ({
      ...job,
      project: batchToProject.get(job.batch_id) || null,
      image_url: `${SUPABASE_URL}/storage/v1/object/public/images/${job.output_storage_path}`,
    }));
  } else {
    // No search term, still attach URLs
    results = results.map((job) => ({
      ...job,
      image_url: `${SUPABASE_URL}/storage/v1/object/public/images/${job.output_storage_path}`,
    }));
  }

  return NextResponse.json({
    query: q || null,
    status: status || null,
    total: results.length,
    results,
  });
}

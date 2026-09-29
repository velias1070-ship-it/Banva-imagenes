import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { clienteInventario } from '@/lib/familias-ml';
import { leerFamiliasYProyectos, leerVariantesNuevas, variantesLibres } from '@/lib/proyectos-familia';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/{id}/missing-variants
 *
 * Variantes de la familia de ML del proyecto (la que sale de sus SKUs) que no
 * están en ningún proyecto: los diseños nuevos. Antes buscaba en ML por palabras
 * del nombre del proyecto («quilt» traía todos los quilts de la cuenta).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const inventario = clienteInventario();
  if (!inventario) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }

  try {
    const resultado = await leerVariantesNuevas(inventario, createAdminClient(), projectId);
    if (!resultado) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    return NextResponse.json(resultado);
  } catch (err) {
    console.error('[GET missing-variants] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}

/**
 * POST /api/projects/{id}/missing-variants
 * Body: { skus: ["TXSBAF144DL20", ...] }
 *
 * Agrega al proyecto las publicaciones pedidas que no están en ningún proyecto
 * —de su familia o buscadas en la lista, p.ej. el mismo quilt que ML separa por
 * tamaño en otra familia— y las suyas que se borraron de la grilla (las demás
 * van en `no_agregadas`): primero a metadata.variantes (salvo las que ya están)
 * y después como swatch sin foto.
 * Si falla el segundo paso, «Traer fotos de ML» (fetch-ml-images con sync_new)
 * crea los swatches que falten desde metadata. Las fotos las baja
 * fetch-ml-images. Dos POST simultáneos pueden duplicar (leer-modificar-escribir
 * sobre metadata, sin único en swatches): con un solo operador no se justifica
 * una RPC.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const pedidos: unknown = body.skus;
  if (!Array.isArray(pedidos) || pedidos.length === 0 || !pedidos.every((s) => typeof s === 'string')) {
    return NextResponse.json({ error: 'skus: lista de SKU requerida' }, { status: 400 });
  }

  const inventario = clienteInventario();
  if (!inventario) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }
  const supabase = createAdminClient();

  try {
    const { familias, proyectos } = await leerFamiliasYProyectos(inventario, supabase);
    if (!proyectos.some((p) => p.id === projectId)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const libres = variantesLibres(familias, proyectos, projectId);
    const agregar = [...new Set((pedidos as string[]).map((s) => s.toUpperCase()))]
      .map((sku) => libres.get(sku))
      .filter((v): v is NonNullable<typeof v> => !!v);
    const agregadasSet = new Set(agregar.map((v) => v.sku.toUpperCase()));
    const noAgregadas = (pedidos as string[]).filter((s) => !agregadasSet.has(s.toUpperCase()));
    if (agregar.length === 0) {
      return NextResponse.json({ agregadas: 0, skus: [], no_agregadas: noAgregadas });
    }

    const { data: proyecto, error: proyErr } = await supabase
      .from('projects')
      .select('metadata')
      .eq('id', projectId)
      .single();
    if (proyErr) throw new Error(`leer proyecto: ${proyErr.message}`);
    const metadata = (proyecto.metadata as Record<string, unknown> | null) ?? {};
    const variantes = Array.isArray(metadata.variantes) ? metadata.variantes : [];
    const yaEnMetadata = new Set(
      variantes
        .map((v) => (v as { sku?: unknown } | null)?.sku)
        .filter((sku): sku is string => typeof sku === 'string')
        .map((sku) => sku.toUpperCase()),
    );
    const aMetadata = agregar.filter((v) => !yaEnMetadata.has(v.sku.toUpperCase()));
    if (aMetadata.length > 0) {
      const { error: updErr } = await supabase
        .from('projects')
        .update({ metadata: { ...metadata, variantes: [...variantes, ...aMetadata] } })
        .eq('id', projectId);
      if (updErr) throw new Error(`guardar metadata: ${updErr.message}`);
    }

    const { data: ultimo, error: ordErr } = await supabase
      .from('swatches')
      .select('display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: false })
      .limit(1);
    if (ordErr) throw new Error(`leer orden: ${ordErr.message}`);
    const desde = (ultimo?.[0]?.display_order ?? -1) + 1;

    const { error: insErr } = await supabase.from('swatches').insert(
      agregar.map((v, i) => ({
        project_id: projectId,
        name: v.color,
        sku_suffix: v.sku,
        color_description: v.color,
        storage_path: '',
        display_order: desde + i,
      })),
    );
    if (insErr) {
      throw new Error(
        `las variantes quedaron guardadas en el proyecto pero no se crearon sus swatches (${insErr.message}): usa «Traer fotos de ML» en la página de Variantes`,
      );
    }

    return NextResponse.json({
      agregadas: agregar.length,
      skus: agregar.map((v) => v.sku),
      no_agregadas: noAgregadas,
    });
  } catch (err) {
    console.error('[POST missing-variants] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}

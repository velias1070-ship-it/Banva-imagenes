import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const MAX_NOMBRE = 80;

/**
 * POST /api/projects/carpeta
 * Body: { project_ids: ["…"], carpeta: "Quilt Atenas" }
 *
 * Guarda la carpeta en metadata.carpeta de cada proyecto. «Mover» manda un
 * proyecto; «Renombrar» manda todos los de la carpeta con el nombre nuevo (si
 * ya existe una carpeta con ese nombre, quedan juntas). Leer y reescribir
 * metadata no es atómico: con un solo operador no se justifica una RPC.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) ?? {};
  const ids: unknown = body.project_ids;
  const carpeta = typeof body.carpeta === 'string' ? body.carpeta.trim() : '';
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
    return NextResponse.json({ error: 'project_ids: lista de proyectos requerida' }, { status: 400 });
  }
  if (!carpeta || carpeta.length > MAX_NOMBRE) {
    return NextResponse.json({ error: `carpeta: nombre de 1 a ${MAX_NOMBRE} caracteres` }, { status: 400 });
  }

  const supabase = createAdminClient();
  const actualizados: string[] = [];
  const noEncontrados: string[] = [];
  const errores: { id: string; error: string }[] = [];
  for (const id of new Set(ids as string[])) {
    const { data: proyecto, error: leerErr } = await supabase
      .from('projects')
      .select('metadata')
      .eq('id', id)
      .maybeSingle();
    if (leerErr) {
      errores.push({ id, error: `leer: ${leerErr.message}` });
      continue;
    }
    if (!proyecto) {
      noEncontrados.push(id);
      continue;
    }
    const metadata = (proyecto.metadata as Record<string, unknown> | null) ?? {};
    const { error: updErr } = await supabase
      .from('projects')
      .update({ metadata: { ...metadata, carpeta } })
      .eq('id', id);
    if (updErr) errores.push({ id, error: `guardar: ${updErr.message}` });
    else actualizados.push(id);
  }

  if (errores.length > 0) console.error('[POST /api/projects/carpeta] errores:', errores);
  return NextResponse.json(
    { carpeta, actualizados: actualizados.length, no_encontrados: noEncontrados, errores },
    { status: errores.length > 0 ? 500 : 200 },
  );
}

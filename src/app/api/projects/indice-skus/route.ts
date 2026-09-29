import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { indicePorSku, leerProyectosConSkus } from '@/lib/proyectos-familia';

// GET /api/projects/indice-skus
//
// SKU (MAYÚSCULAS) → proyectos que lo tienen. Crear proyecto lo usa para avisar
// que una familia ya tiene proyecto (uno por familia de ML).
export async function GET() {
  try {
    const proyectos = await leerProyectosConSkus(createAdminClient());
    return NextResponse.json(indicePorSku(proyectos));
  } catch (err) {
    console.error('[GET /api/projects/indice-skus] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}

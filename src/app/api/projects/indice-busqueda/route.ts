import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { clienteInventario, leerTodo, listarFamilias } from '@/lib/familias-ml';
import { leerProyectosConSkus } from '@/lib/proyectos-familia';
import { armarIndice, type FilaComposicion, type FilaNombre } from '@/lib/busqueda-proyectos';

export const maxDuration = 60;

// GET /api/projects/indice-busqueda
//
// Índice para buscar proyectos por SKU venta, SKU origen, nombre de origen o
// título de ML (src/lib/busqueda-proyectos.ts). La lista de proyectos lo pide
// una vez, la primera vez que se usa el buscador.
export async function GET() {
  const inventario = clienteInventario();
  if (!inventario) {
    return NextResponse.json({ error: 'faltan INVENTORY_SUPABASE_*' }, { status: 500 });
  }
  try {
    const [familias, proyectos, composicion, productos] = await Promise.all([
      listarFamilias(inventario),
      leerProyectosConSkus(createAdminClient()),
      leerTodo<FilaComposicion>((desde, hasta) =>
        inventario.from('composicion_venta').select('sku_venta, sku_origen, unidades, tipo_relacion').order('id').range(desde, hasta),
      ),
      leerTodo<FilaNombre>((desde, hasta) =>
        inventario.from('productos').select('sku, nombre').order('id').range(desde, hasta),
      ),
    ]);
    return NextResponse.json(armarIndice(familias, proyectos, composicion, productos));
  } catch (err) {
    console.error('[GET /api/projects/indice-busqueda] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 });
  }
}

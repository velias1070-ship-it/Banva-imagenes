import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FolderPlus, ImageIcon, Package } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/admin';
import { clienteInventario, listarFamilias, type ProductGroup } from '@/lib/familias-ml';
import { leerProyectosConSkus, type ProyectoSkus } from '@/lib/proyectos-familia';
import { agruparEnCarpetas } from '@/lib/carpetas';
import { ListaCarpetas } from './lista-carpetas';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  let proyectos: ProyectoSkus[] = [];
  let errorProyectos: string | null = null;
  try {
    proyectos = await leerProyectosConSkus(createAdminClient());
  } catch (err) {
    console.error('[/projects] proyectos:', err);
    errorProyectos = err instanceof Error ? err.message : 'Error';
  }

  // Sin las familias de ML los proyectos sin carpeta guardada no se pueden
  // agrupar: van juntos a una carpeta que lo dice.
  let familias: ProductGroup[] = [];
  let errorFamilias: string | null = null;
  const inventario = clienteInventario();
  if (!inventario) {
    errorFamilias = 'faltan INVENTORY_SUPABASE_*';
  } else {
    try {
      familias = await listarFamilias(inventario);
    } catch (err) {
      console.error('[/projects] familias de ML:', err);
      errorFamilias = err instanceof Error ? err.message : 'Error';
    }
  }
  const carpetas = agruparEnCarpetas(familias, proyectos, errorFamilias ? 'Sin agrupar' : undefined);

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Proyectos</h1>
          <p className="text-muted-foreground">
            {proyectos.length} proyectos en {carpetas.length} carpetas, una por producto
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/skus">
            <Button variant="outline">
              <Package className="mr-2 h-4 w-4" />
              Catálogo de SKUs
            </Button>
          </Link>
          <Link href="/projects/new">
            <Button>
              <FolderPlus className="mr-2 h-4 w-4" />
              Nuevo Proyecto
            </Button>
          </Link>
        </div>
      </div>

      {errorProyectos ? (
        <p className="text-sm text-destructive">No pude leer los proyectos: {errorProyectos}</p>
      ) : proyectos.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <ImageIcon className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">No hay proyectos aun</p>
              <Link href="/projects/new" className="mt-4">
                <Button variant="outline">Crear primer proyecto</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ListaCarpetas
          carpetas={carpetas}
          aviso={
            errorFamilias &&
            `No pude leer las familias de ML (${errorFamilias}): los proyectos sin carpeta guardada van en «Sin agrupar».`
          }
        />
      )}
    </div>
  );
}

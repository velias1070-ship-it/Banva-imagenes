import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FolderPlus, ImageIcon, Package, TriangleAlert } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { getInventarioSupabase } from '@/lib/ml-client';
import { leerTodo } from '@/lib/leer-todo';
import {
  familiasDe,
  formatearFecha,
  ordenarPorFamilia,
  skusDeProyecto,
  type FilaProyecto,
} from '@/lib/lista-proyectos';
import type { Project, Swatch } from '@/types/database';
import { ListaProyectos } from './lista-proyectos';

export const dynamic = 'force-dynamic';

type ProyectoDb = Pick<Project, 'id' | 'name' | 'category' | 'sku_base' | 'status' | 'created_at' | 'metadata'>;
type SwatchDb = Pick<Swatch, 'project_id' | 'sku_suffix'>;
interface ProductoDb {
  sku: string;
  familia: string | null;
}

// El motivo de un error va a pantalla y al log. Si la API contesta con una
// página de error completa (un 522 con HTML), postgrest-js la deja entera en
// error.message: se pasa a una sola línea y se recorta.
const MAX_MOTIVO = 200;

// Tope de espera de TODA la lectura de bodega (no de cada página). Proyectos y
// swatches son obligatorios, pero bodega sólo agrega la familia: si se cuelga no
// puede dejar la lista esperando; a los 5 s se corta y sale "no disponible".
const TIEMPO_MAX_BODEGA_MS = 5000;

function motivoCorto(err: unknown): string {
  const texto = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  if (!texto) return 'sin detalle';
  return texto.length > MAX_MOTIVO ? `${texto.slice(0, MAX_MOTIVO)}…` : texto;
}

// Una lectura que puede fallar sin tumbar la página: el error vuelve como dato
// para mostrarlo en pantalla y loguearlo. Nunca se traga.
type Lectura<T> = { ok: true; filas: T[] } | { ok: false; error: string };

async function leer<T>(lectura: () => Promise<T[]>): Promise<Lectura<T>> {
  try {
    return { ok: true, filas: await lectura() };
  } catch (err) {
    return { ok: false, error: motivoCorto(err) };
  }
}

// Una fila por proyecto, con sus SKU de venta (variantes de la metadata + swatches)
// y su familia de bodega. La metadata se queda acá: no viaja al navegador.
function armarFilas(
  proyectos: ProyectoDb[],
  swatches: SwatchDb[],
  familiaPorSku: Map<string, string> | null,
): FilaProyecto[] {
  const sufijosPorProyecto = new Map<string, string[]>();
  for (const swatch of swatches) {
    if (!swatch.sku_suffix) continue;
    const sufijos = sufijosPorProyecto.get(swatch.project_id);
    if (sufijos) sufijos.push(swatch.sku_suffix);
    else sufijosPorProyecto.set(swatch.project_id, [swatch.sku_suffix]);
  }

  return proyectos.map((proyecto) => {
    const skus = skusDeProyecto(proyecto.metadata, sufijosPorProyecto.get(proyecto.id) ?? []);
    return {
      id: proyecto.id,
      name: proyecto.name,
      category: proyecto.category,
      sku_base: proyecto.sku_base,
      status: proyecto.status,
      created_at: proyecto.created_at,
      fecha: formatearFecha(proyecto.created_at),
      skus,
      familias: familiasDe(skus, familiaPorSku),
    };
  });
}

export default async function ProjectsPage() {
  const supabase = await createServerSupabase();

  // Tres lecturas en paralelo, todas por páginas (leerTodo): Supabase corta cada
  // lectura en 1.000 filas y swatches ya pasa de eso. Cada una falla por su
  // cuenta, así un error de bodega no esconde los proyectos.
  const [proyectos, swatches, productos] = await Promise.all([
    leer(() =>
      leerTodo<ProyectoDb>((desde, hasta) =>
        supabase
          .from('projects')
          .select('id, name, category, sku_base, status, created_at, metadata')
          .order('id')
          .range(desde, hasta),
      ),
    ),
    leer(() =>
      leerTodo<SwatchDb>((desde, hasta) =>
        supabase.from('swatches').select('project_id, sku_suffix').order('id').range(desde, hasta),
      ),
    ),
    // Familia de bodega: la tabla productos COMPLETA y sin filtro alguno (un SKU
    // descontinuado conserva su familia). Se usa el cliente de INVENTARIO, que no
    // tiene respaldo: si faltan INVENTORY_* lanza y la página sigue con un aviso.
    // Jamás se cae a la base propia: allí productos es una copia vieja sin familia.
    leer(async () => {
      const bodega = getInventarioSupabase();
      const limite = AbortSignal.timeout(TIEMPO_MAX_BODEGA_MS);
      return leerTodo<ProductoDb>((desde, hasta) =>
        bodega.from('productos').select('sku, familia').order('id').range(desde, hasta).abortSignal(limite),
      );
    }),
  ]);

  // Sin proyectos o sin swatches la búsqueda contestaría "ningún proyecto" con
  // datos a medias: se muestra el error, no una lista vacía.
  const fallas: string[] = [];
  if (!proyectos.ok) {
    console.error(`[projects] proyectos: ${proyectos.error}`);
    fallas.push(`proyectos: ${proyectos.error}`);
  }
  if (!swatches.ok) {
    console.error(`[projects] swatches: ${swatches.error}`);
    fallas.push(`swatches: ${swatches.error}`);
  }

  // productos.sku → productos.familia, con el SKU en MAYÚSCULAS (así lo busca
  // familiasDe). Si bodega no se pudo leer el mapa queda en null: cada tarjeta
  // dice "no disponible" y el orden cae solo al menor SKU.
  let familiaPorSku: Map<string, string> | null = null;
  let avisoFamilia: string | null = null;
  if (productos.ok) {
    familiaPorSku = new Map();
    for (const producto of productos.filas) {
      const sku = (producto.sku ?? '').trim().toUpperCase();
      const familia = (producto.familia ?? '').trim();
      if (sku && familia) familiaPorSku.set(sku, familia);
    }
  } else {
    console.error(`[projects] familia de bodega: ${productos.error}`);
    avisoFamilia = `No se pudo leer la familia desde bodega: ${productos.error}`;
  }

  // Se ordena UNA vez, acá en el servidor: el navegador usa este orden tal cual.
  const filas =
    proyectos.ok && swatches.ok
      ? ordenarPorFamilia(armarFilas(proyectos.filas, swatches.filas, familiaPorSku))
      : [];

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Proyectos</h1>
          <p className="text-muted-foreground">
            Tandas de generación{fallas.length === 0 ? ` (${filas.length})` : ''}
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

      {fallas.length > 0 ? (
        <Card className="mt-8">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <TriangleAlert className="mb-4 h-12 w-12 text-destructive/60" />
              <p className="font-medium">No se pudo leer la lista de proyectos</p>
              <p className="mt-1 text-sm text-muted-foreground">{fallas.join(' · ')}</p>
            </div>
          </CardContent>
        </Card>
      ) : filas.length === 0 ? (
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
        <ListaProyectos filas={filas} avisoFamilia={avisoFamilia} />
      )}
    </div>
  );
}

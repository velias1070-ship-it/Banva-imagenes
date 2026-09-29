'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { coincide, type FilaProyecto } from '@/lib/lista-proyectos';

type Orden = 'familia' | 'recientes';

// SKU de venta que caben en la tarjeta; el resto va como «+N». La búsqueda sí
// mira todos.
const SKUS_EN_TARJETA = 3;

interface Props {
  /** Ya ordenadas por familia en el servidor (ordenarPorFamilia). */
  filas: FilaProyecto[];
  /** Si bodega no se pudo leer, el motivo listo para mostrar; si se leyó, null. */
  avisoFamilia: string | null;
}

// Más nuevo primero. Una fecha que no se puede leer (NaN) va al final: un NaN
// dentro del comparador dejaría el orden de toda la lista sin sentido.
function masNuevoPrimero(a: FilaProyecto, b: FilaProyecto): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  const aValida = !Number.isNaN(ta);
  const bValida = !Number.isNaN(tb);
  if (aValida && bValida) return tb - ta;
  if (aValida) return -1;
  if (bValida) return 1;
  return 0;
}

// Tres estados, nunca un valor inventado: null = bodega no se pudo leer,
// [] = se leyó y ningún SKU del proyecto tiene familia.
function textoFamilia(familias: string[] | null): string {
  if (familias === null) return 'Familia: no disponible';
  if (familias.length === 0) return 'Sin familia en bodega';
  return `Familia: ${familias.join(' · ')}`;
}

function TarjetaProyecto({ fila }: { fila: FilaProyecto }) {
  const chips = fila.skus.slice(0, SKUS_EN_TARJETA);
  const resto = fila.skus.length - chips.length;

  return (
    <Link href={`/projects/${fila.id}`}>
      <Card className="cursor-pointer transition-shadow hover:shadow-md">
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold">{fila.name}</h3>
              <p className="text-sm text-muted-foreground">{fila.category}</p>
            </div>
            <Badge variant={fila.status === 'active' ? 'default' : 'secondary'}>{fila.status}</Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{textoFamilia(fila.familias)}</p>
          {chips.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">Sin SKU de venta</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {chips.map((sku) => (
                <Badge key={sku} variant="outline" className="font-mono text-[10px]">
                  {sku}
                </Badge>
              ))}
              {resto > 0 && <span className="text-[10px] text-muted-foreground">+{resto}</span>}
            </div>
          )}
          {fila.fecha && <p className="mt-2 text-xs text-muted-foreground">{fila.fecha}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

// Lista de proyectos con buscador y dos órdenes. El estado vive sólo acá (nada
// en la URL). La metadata de cada proyecto no llega al navegador: el servidor ya
// dejó en cada fila sus SKU, sus familias y la fecha formateada.
export function ListaProyectos({ filas, avisoFamilia }: Props) {
  const [q, setQ] = useState('');
  const [orden, setOrden] = useState<Orden>('familia');

  // «Familia» usa el arreglo tal como llegó del servidor, sin reordenar acá: el
  // orden se calculó una vez allá y así el navegador no puede discrepar del HTML
  // inicial. «Recientes» ordena una copia.
  const ordenadas = useMemo(
    () => (orden === 'recientes' ? [...filas].sort(masNuevoPrimero) : filas),
    [filas, orden],
  );
  const visibles = useMemo(() => ordenadas.filter((fila) => coincide(fila, q)), [ordenadas, q]);

  return (
    <div>
      {avisoFamilia && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{avisoFamilia}</p>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, SKU o familia..."
            aria-label="Buscar proyectos"
            className="pl-9"
          />
        </div>
        <Tabs value={orden} onValueChange={(v) => setOrden(v === 'recientes' ? 'recientes' : 'familia')}>
          <TabsList aria-label="Ordenar por">
            <TabsTrigger value="familia">Familia</TabsTrigger>
            <TabsTrigger value="recientes">Recientes</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        {visibles.length} de {filas.length} proyectos
      </p>

      {visibles.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">Ningún proyecto coincide con «{q.trim()}»</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibles.map((fila) => (
            <TarjetaProyecto key={fila.id} fila={fila} />
          ))}
        </div>
      )}
    </div>
  );
}

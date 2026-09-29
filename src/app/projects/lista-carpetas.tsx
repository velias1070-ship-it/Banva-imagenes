'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Folder, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sinTildes } from '@/lib/familias-ml';
import type { Carpeta } from '@/lib/carpetas';
import { buscarSkus, type IndiceBusqueda, type ResultadoSkus } from '@/lib/busqueda-proyectos';

interface IProps {
  carpetas: Carpeta[];
  /** La de los proyectos sin producto: no se renombra ni es destino. */
  sinGrupo: string;
  aviso: string | null;
}

const NUEVA = '__nueva__';

// Proyectos por carpeta (una por producto). Para corregir: «Mover» un proyecto
// a otra carpeta, o «Renombrar» una carpeta (con el nombre de otra, se juntan).
// El buscador encuentra carpeta, proyecto, SKU venta, SKU origen, nombre de
// origen o título de ML (src/lib/busqueda-proyectos.ts).
export function ListaCarpetas({ carpetas, sinGrupo, aviso }: IProps) {
  const router = useRouter();
  const [busqueda, setBusqueda] = useState('');
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [indice, setIndice] = useState<IndiceBusqueda | null>(null);
  const [errorIndice, setErrorIndice] = useState<string | null>(null);
  const pedido = useRef(false);

  // El índice de SKU se pide una vez, al empezar a buscar; si falla, sólo se
  // vuelve a pedir con «Reintentar».
  function cargarIndice(reintentar = false) {
    if (indice || (pedido.current && !reintentar)) return;
    pedido.current = true;
    setErrorIndice(null);
    fetch('/api/projects/indice-busqueda')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `error ${res.status}`);
        setIndice(data as IndiceBusqueda);
      })
      .catch((err) => {
        console.error('[lista-carpetas] índice de búsqueda:', err);
        setErrorIndice(err instanceof Error ? err.message : 'Error');
      });
  }

  const tokens = sinTildes(busqueda).split(/\s+/).filter(Boolean);
  const skus = indice && tokens.length ? buscarSkus(indice, tokens) : null;
  const cargando = tokens.length > 0 && !indice && !errorIndice;
  const visibles = tokens.length
    ? carpetas.filter((c) => {
        const texto = sinTildes([c.nombre, ...c.proyectos.map((p) => p.name)].join(' '));
        return tokens.every((t) => texto.includes(t)) || c.proyectos.some((p) => skus?.proyectos.has(p.id));
      })
    : carpetas;
  const destinos = carpetas.map((c) => c.nombre).filter((n) => n !== sinGrupo);
  const nombres = new Map(carpetas.flatMap((c) => c.proyectos.map((p) => [p.id, p.name] as const)));

  function alternar(nombre: string) {
    setAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(nombre)) next.delete(nombre);
      else next.add(nombre);
      return next;
    });
  }

  async function guardar(ids: string[], carpeta: string, abrir: string) {
    setGuardando(true);
    try {
      const res = await fetch('/api/projects/carpeta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_ids: ids, carpeta }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data.error ||
            `${data.actualizados ? `Se guardaron ${data.actualizados}, pero ` : ''}${data.errores?.length ?? 'alguno'} no se pudo guardar`,
        );
      } else {
        toast.success(`Listo: ${data.actualizados} en «${data.carpeta}»`);
        setAbiertas((prev) => new Set(prev).add(abrir));
      }
      router.refresh();
    } catch {
      toast.error('Error de conexion');
    } finally {
      setGuardando(false);
    }
  }

  function renombrar(c: Carpeta) {
    const nuevo = window.prompt('Nombre de la carpeta (si ya existe otra con ese nombre, se juntan):', c.nombre)?.trim();
    if (!nuevo || nuevo === c.nombre) return;
    guardar(
      c.proyectos.map((p) => p.id),
      nuevo,
      nuevo,
    );
  }

  function mover(proyectoId: string, desde: string, destino: string) {
    const nombre = destino === NUEVA ? window.prompt('Nombre de la carpeta nueva:')?.trim() : destino;
    if (!nombre || nombre === desde) return;
    guardar([proyectoId], nombre, desde);
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={busqueda}
          onFocus={() => cargarIndice()}
          onChange={(e) => {
            cargarIndice();
            setBusqueda(e.target.value);
          }}
          placeholder="Buscar carpeta, proyecto, producto o SKU"
          className="pl-8"
        />
      </div>
      {aviso && <p className="text-xs text-destructive">{aviso}</p>}
      {cargando && <p className="text-xs text-muted-foreground">Buscando también por SKU…</p>}
      {tokens.length > 0 && errorIndice && (
        <p className="text-xs text-destructive">
          No pude cargar los SKU ({errorIndice}): por ahora busca sólo por carpeta o proyecto.{' '}
          <button type="button" onClick={() => cargarIndice(true)} className="underline">
            Reintentar
          </button>
        </p>
      )}
      {skus && skus.grupos.length > 0 && <SkuRelacionados skus={skus} nombres={nombres} />}
      {visibles.length === 0 && !skus?.grupos.length && !cargando && (
        <p className="text-sm text-muted-foreground">Sin resultados</p>
      )}

      {visibles.map((c) => {
        const abierta = tokens.length > 0 || abiertas.has(c.nombre);
        return (
          <div key={c.nombre} className="rounded-md border">
            <button
              type="button"
              onClick={() => alternar(c.nombre)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent"
            >
              <ChevronRight className={`h-4 w-4 flex-shrink-0 transition-transform ${abierta ? 'rotate-90' : ''}`} />
              <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{c.nombre}</span>
              <span className="text-sm text-muted-foreground">
                {c.proyectos.length} {c.proyectos.length === 1 ? 'proyecto' : 'proyectos'}
              </span>
            </button>
            {abierta && (
              <div className="space-y-2 border-t px-4 py-3">
                {c.proyectos.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 text-sm">
                    <Link href={`/projects/${p.id}`} className="min-w-0 flex-1 truncate hover:underline">
                      {p.name}
                    </Link>
                    {p.status && <Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge>}
                    <span className="w-20 text-right text-xs text-muted-foreground">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString('es-CL') : ''}
                    </span>
                    <select
                      aria-label={`Mover ${p.name} a otra carpeta`}
                      value={c.nombre}
                      disabled={guardando}
                      onChange={(e) => mover(p.id, c.nombre, e.target.value)}
                      className="h-8 w-36 rounded-md border bg-background px-2 text-xs"
                    >
                      <option value={c.nombre}>Mover a…</option>
                      {destinos
                        .filter((n) => n !== c.nombre)
                        .map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      <option value={NUEVA}>Carpeta nueva…</option>
                    </select>
                  </div>
                ))}
                {c.nombre !== sinGrupo && (
                  <Button variant="ghost" size="sm" disabled={guardando} onClick={() => renombrar(c)}>
                    Renombrar carpeta
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Por cada SKU origen que calza: todos los SKU venta que lo llevan y en qué
// proyecto está cada uno.
function SkuRelacionados({ skus, nombres }: { skus: ResultadoSkus; nombres: Map<string, string> }) {
  return (
    <div className="space-y-3 rounded-md border px-4 py-3">
      <p className="text-sm font-medium">SKU relacionados</p>
      {skus.grupos.map((g) => (
        <div key={g.origen ?? '(sin origen)'} className="space-y-1">
          <p className="truncate text-xs text-muted-foreground">
            {g.origen ? (
              <>
                Origen <span className="font-mono">{g.origen}</span>
                {g.nombre && ` · ${g.nombre}`}
              </>
            ) : (
              'Sin SKU origen en Bodega'
            )}
          </p>
          {g.ventas.map((v) => (
            <div key={v.sku} className="flex items-center gap-2 pl-3 text-sm">
              <span className="font-mono">{v.sku}</span>
              {v.unidades !== null && v.unidades > 1 && (
                <span className="text-xs text-muted-foreground">×{v.unidades}</span>
              )}
              {v.combo && <span className="text-xs text-muted-foreground">combo</span>}
              <span className="min-w-0 flex-1" />
              {v.proyectos.length > 0 ? (
                <span className="min-w-0 truncate text-xs">
                  <Link href={`/projects/${v.proyectos[0]}`} className="hover:underline">
                    {nombres.get(v.proyectos[0]) ?? 'proyecto'}
                  </Link>
                  {v.proyectos.length > 1 && <span className="text-muted-foreground"> y {v.proyectos.length - 1} más</span>}
                </span>
              ) : (
                <span className="text-xs text-amber-600">sin proyecto</span>
              )}
            </div>
          ))}
        </div>
      ))}
      {skus.ocultos > 0 && (
        <p className="text-xs text-muted-foreground">Y {skus.ocultos} SKU origen más: escribe más para acotar.</p>
      )}
    </div>
  );
}

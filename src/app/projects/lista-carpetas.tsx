'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Folder, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sinTildes } from '@/lib/familias-ml';
import type { Carpeta } from '@/lib/carpetas';

interface IProps {
  carpetas: Carpeta[];
  aviso: string | null;
}

const NUEVA = '__nueva__';

// Proyectos por carpeta (una por producto). Para corregir: «Mover» un proyecto
// a otra carpeta, o «Renombrar» una carpeta (con el nombre de otra, se juntan).
export function ListaCarpetas({ carpetas, aviso }: IProps) {
  const router = useRouter();
  const [busqueda, setBusqueda] = useState('');
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);

  const tokens = sinTildes(busqueda).split(/\s+/).filter(Boolean);
  const visibles = tokens.length
    ? carpetas.filter((c) => {
        const texto = sinTildes([c.nombre, ...c.proyectos.map((p) => p.name)].join(' '));
        return tokens.every((t) => texto.includes(t));
      })
    : carpetas;
  const nombres = carpetas.map((c) => c.nombre);

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
        toast.error(data.error || `No se guardó (${data.errores?.length ?? res.status} con error)`);
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
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar carpeta o proyecto"
          className="pl-8"
        />
      </div>
      {aviso && <p className="text-xs text-destructive">{aviso}</p>}
      {visibles.length === 0 && <p className="text-sm text-muted-foreground">Sin resultados</p>}

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
                      {nombres.map((n) => (
                        <option key={n} value={n}>
                          {n === c.nombre ? 'Mover a…' : n}
                        </option>
                      ))}
                      <option value={NUEVA}>Carpeta nueva…</option>
                    </select>
                  </div>
                ))}
                <Button variant="ghost" size="sm" disabled={guardando} onClick={() => renombrar(c)}>
                  Renombrar carpeta
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

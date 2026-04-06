'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Sparkles, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

interface Hero {
  id: string;
  filename: string;
  shot_type: string;
}

interface Props {
  projectId: string;
  brandName: string | null;
  hasBrand: boolean;
  heroCount: number;
}

export function BrandRegenButton({ projectId, brandName, hasBrand, heroCount }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingHeroes, setLoadingHeroes] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (expanded && heroes.length === 0) {
      setLoadingHeroes(true);
      fetch(`/api/projects/${projectId}/heroes`)
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) {
            setHeroes(data);
            setSelected(new Set(data.map((h: Hero) => h.id)));
          }
        })
        .finally(() => setLoadingHeroes(false));
    }
  }, [expanded, projectId, heroes.length]);

  function toggleHero(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBrandRegen() {
    if (!hasBrand) {
      setResult({ ok: false, message: 'Asigna un Brand Book en Configuracion primero.' });
      return;
    }
    if (selected.size === 0) {
      setResult({ ok: false, message: 'Selecciona al menos una imagen.' });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/brand-regen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_ids: selected.size === heroes.length ? undefined : Array.from(selected),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ ok: false, message: data.error || 'Error al iniciar regeneracion' });
        return;
      }

      setResult({
        ok: true,
        message: `Batch creado: ${data.total_jobs} imagenes con brand "${data.brand}".`,
      });

      setTimeout(() => router.push(`/projects/${projectId}/generate`), 2000);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Error de red' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader
        className="flex cursor-pointer flex-row items-center gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        <Sparkles className="h-8 w-8 text-pink-500" />
        <div className="flex-1">
          <CardTitle className="text-base">Regenerar con Brand</CardTitle>
          <CardDescription>
            Toma las imagenes hero existentes y las regenera aplicando el Brand Book
          </CardDescription>
        </div>
        {expanded ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
      </CardHeader>
      {expanded && (
        <CardContent>
          {!hasBrand ? (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-500">
              Sin Brand Book asignado. Configuralo en la seccion de Configuracion.
            </div>
          ) : heroCount === 0 ? (
            <div className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
              No hay imagenes hero. Sube imagenes primero en la seccion Hero Shots.
            </div>
          ) : (
            <>
              <div className="mb-3 text-sm text-muted-foreground">
                Brand: <span className="font-medium text-foreground">{brandName}</span>
              </div>

              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Seleccionar imagenes</span>
                  <div className="flex gap-2">
                    <button onClick={() => setSelected(new Set(heroes.map((h) => h.id)))} className="text-xs text-primary hover:underline">Todas</button>
                    <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:underline">Ninguna</button>
                  </div>
                </div>

                {loadingHeroes ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">Cargando imagenes...</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                    {heroes.map((h) => (
                      <label
                        key={h.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                          selected.has(h.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                        }`}
                      >
                        <Checkbox
                          checked={selected.has(h.id)}
                          onCheckedChange={() => toggleHero(h.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">{h.filename}</div>
                          <div className="text-[10px] text-muted-foreground">{h.shot_type}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {selected.size} de {heroes.length} seleccionadas
                </span>
                <Button
                  onClick={handleBrandRegen}
                  disabled={loading || selected.size === 0}
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Procesando...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Regenerar {selected.size > 0 ? `(${selected.size})` : ''}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          {result && (
            <div className={`mt-3 rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
              {result.message}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

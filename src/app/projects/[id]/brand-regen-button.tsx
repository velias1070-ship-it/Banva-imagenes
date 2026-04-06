'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Sparkles, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

interface Swatch {
  id: string;
  name: string;
  sku_suffix: string | null;
}

interface Props {
  projectId: string;
  brandName: string | null;
  hasBrand: boolean;
  swatchCount: number;
}

export function BrandRegenButton({ projectId, brandName, hasBrand, swatchCount }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingSwatches, setLoadingSwatches] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (expanded && swatches.length === 0) {
      setLoadingSwatches(true);
      fetch(`/api/projects/${projectId}/swatches`)
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) {
            const withSku = data.filter((s: Swatch) => s.sku_suffix);
            setSwatches(withSku);
          }
        })
        .finally(() => setLoadingSwatches(false));
    }
  }, [expanded, projectId, swatches.length]);

  function toggleSwatch(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(swatches.map((s) => s.id)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function handleBrandRegen() {
    if (!hasBrand) {
      setResult({ ok: false, message: 'Asigna un Brand Book en Configuracion primero.' });
      return;
    }

    if (selected.size === 0) {
      setResult({ ok: false, message: 'Selecciona al menos una variante.' });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/brand-regen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swatch_ids: Array.from(selected) }),
      });

      const data = await res.json();

      if (!res.ok) {
        setResult({ ok: false, message: data.error || 'Error al iniciar regeneracion' });
        return;
      }

      setResult({
        ok: true,
        message: `Batch creado: ${data.total_jobs} imagenes de ${data.ml_images_fetched} variantes con brand "${data.brand}". ${data.errors?.length ? `(${data.errors.length} errores)` : ''}`,
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
            Descarga las imagenes actuales de ML y las regenera con el Brand Book aplicado
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
          ) : (
            <>
              <div className="mb-3 text-sm text-muted-foreground">
                Brand: <span className="font-medium text-foreground">{brandName}</span>
              </div>

              {/* Variant selector */}
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Seleccionar variantes</span>
                  <div className="flex gap-2">
                    <button onClick={selectAll} className="text-xs text-primary hover:underline">Todas</button>
                    <button onClick={selectNone} className="text-xs text-muted-foreground hover:underline">Ninguna</button>
                  </div>
                </div>

                {loadingSwatches ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">Cargando variantes...</div>
                ) : swatches.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">No hay variantes con SKU vinculado</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                    {swatches.map((s) => (
                      <label
                        key={s.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                          selected.has(s.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                        }`}
                      >
                        <Checkbox
                          checked={selected.has(s.id)}
                          onCheckedChange={() => toggleSwatch(s.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{s.name}</div>
                          <div className="truncate text-[10px] text-muted-foreground">{s.sku_suffix}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Action */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {selected.size} de {swatches.length} seleccionadas
                </span>
                <Button
                  onClick={handleBrandRegen}
                  disabled={loading || selected.size === 0}
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Descargando de ML...
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

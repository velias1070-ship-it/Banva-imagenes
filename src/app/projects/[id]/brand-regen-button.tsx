'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Sparkles, Loader2, ChevronDown, ChevronUp, Download, ImageIcon } from 'lucide-react';

interface Hero {
  id: string;
  filename: string;
  shot_type: string;
}

interface Swatch {
  id: string;
  name: string;
  sku_suffix: string | null;
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
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [selectedHeroes, setSelectedHeroes] = useState<Set<string>>(new Set());
  const [selectedSwatches, setSelectedSwatches] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<'heroes' | 'ml'>('ml');
  const [loadingData, setLoadingData] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [progress, setProgress] = useState('');

  useEffect(() => {
    if (expanded && swatches.length === 0) {
      setLoadingData(true);
      Promise.all([
        fetch(`/api/projects/${projectId}/heroes`).then((r) => r.json()),
        fetch(`/api/projects/${projectId}/swatches`).then((r) => r.json()),
      ])
        .then(([heroData, swatchData]) => {
          if (Array.isArray(heroData)) {
            setHeroes(heroData);
            setSelectedHeroes(new Set(heroData.map((h: Hero) => h.id)));
          }
          if (Array.isArray(swatchData)) {
            setSwatches(swatchData);
          }
        })
        .finally(() => setLoadingData(false));
    }
  }, [expanded, projectId, swatches.length]);

  function toggleSwatch(id: string) {
    setSelectedSwatches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleHero(id: string) {
    setSelectedHeroes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const swatchesWithSku = swatches.filter((s) => s.sku_suffix);
  const canUseML = swatchesWithSku.length > 0;

  async function handleBrandRegen() {
    if (!hasBrand) {
      setResult({ ok: false, message: 'Asigna un Brand Book en Configuracion primero.' });
      return;
    }
    if (selectedSwatches.size === 0) {
      setResult({ ok: false, message: 'Selecciona al menos una variante.' });
      return;
    }
    if (source === 'heroes' && selectedHeroes.size === 0) {
      setResult({ ok: false, message: 'Selecciona al menos una imagen.' });
      return;
    }

    setLoading(true);
    setResult(null);

    const swatchIds = Array.from(selectedSwatches);
    let totalJobs = 0;
    const errors: string[] = [];

    for (let i = 0; i < swatchIds.length; i++) {
      const swatch = swatches.find((s) => s.id === swatchIds[i]);
      setProgress(`${swatch?.name || ''} (${i + 1}/${swatchIds.length})`);

      try {
        const bodyPayload: Record<string, unknown> = {
          target_swatch_id: swatchIds[i],
          source,
        };

        if (source === 'heroes') {
          bodyPayload.hero_ids = selectedHeroes.size === heroes.length ? undefined : Array.from(selectedHeroes);
        }

        const res = await fetch(`/api/projects/${projectId}/brand-regen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        });

        const data = await res.json();

        if (!res.ok) {
          errors.push(`${swatch?.name}: ${data.error}`);
        } else {
          totalJobs += data.total_jobs;
        }
      } catch (err) {
        errors.push(`${swatch?.name}: ${err instanceof Error ? err.message : 'Error'}`);
      }
    }

    setProgress('');

    if (totalJobs > 0) {
      setResult({
        ok: true,
        message: `${totalJobs} imagenes en ${swatchIds.length} variante(s) con brand "${brandName}".${errors.length ? ` ${errors.length} error(es).` : ''}`,
      });
      setTimeout(() => router.push(`/projects/${projectId}/generate`), 2000);
    } else {
      setResult({ ok: false, message: errors.join('. ') || 'Error al procesar' });
    }

    setLoading(false);
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
            Aplica el Brand Book a imagenes existentes o descargadas de ML
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
          ) : loadingData ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Cargando datos...</div>
          ) : (
            <>
              <div className="mb-3 text-sm text-muted-foreground">
                Brand: <span className="font-medium text-foreground">{brandName}</span>
              </div>

              {/* Step 1: Select variants */}
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">1. Variantes</span>
                  <div className="flex gap-2">
                    <button onClick={() => setSelectedSwatches(new Set(swatches.map((s) => s.id)))} className="text-xs text-primary hover:underline">Todas</button>
                    <button onClick={() => setSelectedSwatches(new Set())} className="text-xs text-muted-foreground hover:underline">Ninguna</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                  {swatches.map((s) => (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                        selectedSwatches.has(s.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                      }`}
                    >
                      <Checkbox
                        checked={selectedSwatches.has(s.id)}
                        onCheckedChange={() => toggleSwatch(s.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-xs">{s.name}</div>
                        {s.sku_suffix && <div className="truncate text-[10px] text-muted-foreground">{s.sku_suffix}</div>}
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Step 2: Source */}
              {selectedSwatches.size > 0 && (
                <div className="mb-4">
                  <label className="mb-2 block text-sm font-medium">2. Origen de las imagenes</label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={source === 'ml' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSource('ml')}
                      disabled={!canUseML}
                    >
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Traer de ML
                    </Button>
                    <Button
                      type="button"
                      variant={source === 'heroes' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSource('heroes')}
                      disabled={heroes.length === 0}
                    >
                      <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
                      Heroes existentes ({heroes.length})
                    </Button>
                  </div>
                  {source === 'ml' && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Descargará las fotos de ML de cada variante seleccionada en 1200x1200
                    </p>
                  )}
                </div>
              )}

              {/* Step 3: Hero selection (only for source='heroes') */}
              {selectedSwatches.size > 0 && source === 'heroes' && heroes.length > 0 && (
                <div className="mb-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">3. Seleccionar imagenes</span>
                    <div className="flex gap-2">
                      <button onClick={() => setSelectedHeroes(new Set(heroes.map((h) => h.id)))} className="text-xs text-primary hover:underline">Todas</button>
                      <button onClick={() => setSelectedHeroes(new Set())} className="text-xs text-muted-foreground hover:underline">Ninguna</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                    {heroes.map((h) => (
                      <label
                        key={h.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                          selectedHeroes.has(h.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                        }`}
                      >
                        <Checkbox
                          checked={selectedHeroes.has(h.id)}
                          onCheckedChange={() => toggleHero(h.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">{h.filename}</div>
                          <div className="text-[10px] text-muted-foreground">{h.shot_type}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Action */}
              {selectedSwatches.size > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {selectedSwatches.size} variante(s) · {source === 'ml' ? 'desde ML' : `${selectedHeroes.size} imagenes`}
                  </span>
                  <Button
                    onClick={handleBrandRegen}
                    disabled={loading || selectedSwatches.size === 0 || (source === 'heroes' && selectedHeroes.size === 0)}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {progress || 'Procesando...'}
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        Regenerar ({selectedSwatches.size})
                      </>
                    )}
                  </Button>
                </div>
              )}
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

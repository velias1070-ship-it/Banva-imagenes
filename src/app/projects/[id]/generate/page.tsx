'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowLeft, Play, Loader2, CheckCircle, AlertTriangle, XCircle, ImageIcon } from 'lucide-react';
import type { Swatch, GenerationBatch } from '@/types/database';
import { COST_PER_IMAGE_USD } from '@/lib/constants';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

function getStorageUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/images/${path}`;
}

interface HeroWithStatus {
  id: string;
  filename: string;
  shot_type: string;
  storage_path: string;
  display_order: number;
  total_jobs: number;
  approved_jobs: number;
  swatches_count: number;
}

export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const [heroesWithStatus, setHeroesWithStatus] = useState<HeroWithStatus[]>([]);
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [selectedHeroIds, setSelectedHeroIds] = useState<Set<string>>(new Set());
  const [selectedSwatchIds, setSelectedSwatchIds] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<GenerationBatch | null>(null);
  const [generating, setGenerating] = useState(false);

  const fetchData = useCallback(async () => {
    const [heroStatusRes, swatchRes] = await Promise.all([
      fetch(`/api/projects/${id}/generate`),
      fetch(`/api/projects/${id}/swatches`),
    ]);
    if (heroStatusRes.ok) {
      const heroData: HeroWithStatus[] = await heroStatusRes.json();
      setHeroesWithStatus(heroData);
      // Auto-select heroes that have NOT been fully processed
      const newSelected = new Set<string>();
      for (const hero of heroData) {
        if (hero.approved_jobs < hero.swatches_count) {
          newSelected.add(hero.id);
        }
      }
      // If all are processed, select none (user must explicitly choose)
      setSelectedHeroIds(newSelected);
    }
    if (swatchRes.ok) {
      const swatchData: Swatch[] = await swatchRes.json();
      setSwatches(swatchData);
      // Auto-select all swatches
      setSelectedSwatchIds(new Set(swatchData.map((s) => s.id)));
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll for batch progress
  useEffect(() => {
    if (!batch || batch.status === 'completed' || batch.status === 'failed') return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/batches/${batch.id}`);
      if (res.ok) {
        const updated = await res.json();
        setBatch(updated);
        if (updated.status === 'completed') {
          toast.success('Generacion completada!');
          setGenerating(false);
          fetchData(); // Refresh hero status
        } else if (updated.status === 'failed' || updated.status === 'halted') {
          toast.error('La generacion tuvo errores');
          setGenerating(false);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [batch, fetchData]);

  const selectedCount = selectedHeroIds.size;
  const selectedSwatchCount = selectedSwatchIds.size;
  const totalCombinations = selectedCount * selectedSwatchCount;
  const estimatedCost = (totalCombinations * COST_PER_IMAGE_USD).toFixed(2);
  const estimatedTime = Math.ceil((totalCombinations * 7) / 60);

  const newHeroes = useMemo(
    () => heroesWithStatus.filter((h) => h.approved_jobs < h.swatches_count),
    [heroesWithStatus]
  );

  function toggleHero(heroId: string) {
    setSelectedHeroIds((prev) => {
      const next = new Set(prev);
      if (next.has(heroId)) {
        next.delete(heroId);
      } else {
        next.add(heroId);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedHeroIds(new Set(heroesWithStatus.map((h) => h.id)));
  }

  function selectNewOnly() {
    setSelectedHeroIds(new Set(newHeroes.map((h) => h.id)));
  }

  function selectNone() {
    setSelectedHeroIds(new Set());
  }

  function toggleSwatch(swatchId: string) {
    setSelectedSwatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(swatchId)) {
        next.delete(swatchId);
      } else {
        next.add(swatchId);
      }
      return next;
    });
  }

  function selectAllSwatches() {
    setSelectedSwatchIds(new Set(swatches.map((s) => s.id)));
  }

  function selectNoSwatches() {
    setSelectedSwatchIds(new Set());
  }

  async function handleGenerate() {
    if (selectedCount === 0) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/projects/${id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_ids: Array.from(selectedHeroIds),
          swatch_ids: Array.from(selectedSwatchIds),
        }),
      });

      if (res.ok) {
        const newBatch = await res.json();
        setBatch(newBatch);
        toast.success('Pipeline iniciado!');
      } else {
        const err = await res.json();
        toast.error(err.error || 'Error al iniciar generacion');
        setGenerating(false);
      }
    } catch {
      toast.error('Error de conexion');
      setGenerating(false);
    }
  }

  const progress = batch
    ? Math.round((batch.completed_count / batch.total_combinations) * 100)
    : 0;

  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold">Generar Variantes</h1>
        <p className="text-muted-foreground">Selecciona los heroes y lanza el pipeline</p>
      </div>

      {/* Hero Selection */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Seleccionar Hero Shots</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={selectAll}>
                Todos
              </Button>
              {newHeroes.length > 0 && newHeroes.length < heroesWithStatus.length && (
                <Button variant="outline" size="sm" onClick={selectNewOnly}>
                  Solo nuevos ({newHeroes.length})
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={selectNone}>
                Ninguno
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {heroesWithStatus.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              No hay hero shots.{' '}
              <Link href={`/projects/${id}/heroes`} className="text-blue-600 hover:underline">
                Subir heroes
              </Link>
            </p>
          ) : (
            <div className="space-y-3">
              {heroesWithStatus.map((hero) => {
                const isFullyProcessed = hero.approved_jobs >= hero.swatches_count && hero.swatches_count > 0;
                const isPartial = hero.approved_jobs > 0 && hero.approved_jobs < hero.swatches_count;
                const isSelected = selectedHeroIds.has(hero.id);

                return (
                  <div
                    key={hero.id}
                    className={`flex items-center gap-4 rounded-lg border p-3 transition-colors cursor-pointer hover:bg-gray-50 ${
                      isSelected ? 'border-blue-300 bg-blue-50/50' : ''
                    }`}
                    onClick={() => toggleHero(hero.id)}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleHero(hero.id)}
                      onClick={(e) => e.stopPropagation()}
                    />

                    {/* Thumbnail */}
                    <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-md bg-gray-100">
                      <Image
                        src={getStorageUrl(hero.storage_path)}
                        alt={hero.filename}
                        fill
                        className="object-cover"
                        sizes="64px"
                      />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{hero.filename}</p>
                      <p className="text-xs text-muted-foreground capitalize">{hero.shot_type}</p>
                    </div>

                    {/* Status Badge */}
                    {isFullyProcessed && (
                      <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100 gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Procesado ({hero.approved_jobs}/{hero.swatches_count})
                      </Badge>
                    )}
                    {isPartial && (
                      <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Parcial ({hero.approved_jobs}/{hero.swatches_count})
                      </Badge>
                    )}
                    {hero.total_jobs === 0 && (
                      <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100 gap-1">
                        <ImageIcon className="h-3 w-3" />
                        Nuevo
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Swatch Selection */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Seleccionar Swatches</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={selectAllSwatches}>
                Todos ({swatches.length})
              </Button>
              <Button variant="outline" size="sm" onClick={selectNoSwatches}>
                Ninguno
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {swatches.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              No hay swatches.{' '}
              <Link href={`/projects/${id}/swatches`} className="text-blue-600 hover:underline">
                Subir swatches
              </Link>
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {swatches.map((swatch) => {
                const isSelected = selectedSwatchIds.has(swatch.id);
                return (
                  <div
                    key={swatch.id}
                    className={`relative flex flex-col items-center gap-2 rounded-lg border p-2 transition-colors cursor-pointer hover:bg-gray-50 ${
                      isSelected ? 'border-purple-300 bg-purple-50/50' : ''
                    }`}
                    onClick={() => toggleSwatch(swatch.id)}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSwatch(swatch.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-1 left-1"
                    />
                    <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-md bg-gray-100">
                      <Image
                        src={getStorageUrl(swatch.storage_path)}
                        alt={swatch.name}
                        fill
                        className="object-cover"
                        sizes="64px"
                      />
                    </div>
                    <p className="text-xs text-center text-muted-foreground truncate w-full">
                      {swatch.name.length > 20 ? swatch.name.substring(0, 20) + '...' : swatch.name}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Matrix Preview */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Matriz de Combinaciones</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-3xl font-bold text-blue-600">{selectedCount}</div>
              <p className="text-sm text-muted-foreground">
                Hero{selectedCount !== 1 ? 's' : ''} seleccionado{selectedCount !== 1 ? 's' : ''}
              </p>
            </div>
            <div>
              <div className="text-3xl font-bold text-gray-400">x</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-purple-600">{selectedSwatchCount}</div>
              <p className="text-sm text-muted-foreground">
                Swatch{selectedSwatchCount !== 1 ? 'es' : ''} seleccionado{selectedSwatchCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-lg bg-gray-50 p-4 text-center">
            <div className="text-4xl font-bold">{totalCombinations}</div>
            <p className="text-sm text-muted-foreground">imagenes a generar</p>
          </div>

          <div className="mt-4 flex justify-between text-sm text-muted-foreground">
            <span>Costo estimado: ~${estimatedCost} USD</span>
            <span>Tiempo estimado: ~{estimatedTime} min</span>
          </div>
        </CardContent>
      </Card>

      {/* Generation Progress */}
      {batch && (
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Progreso</CardTitle>
              <Badge
                variant={
                  batch.status === 'completed'
                    ? 'default'
                    : batch.status === 'failed'
                    ? 'destructive'
                    : 'secondary'
                }
              >
                {batch.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={progress} className="mb-4" />
            <p className="mb-4 text-center text-sm text-muted-foreground">
              {batch.completed_count} / {batch.total_combinations} ({progress}%)
            </p>
            <div className="grid grid-cols-4 gap-3">
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <div>
                  <div className="text-lg font-bold">{batch.approved_count}</div>
                  <p className="text-xs text-muted-foreground">Aprobadas</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <Loader2 className="h-5 w-5 text-yellow-500" />
                <div>
                  <div className="text-lg font-bold">{batch.retry_count}</div>
                  <p className="text-xs text-muted-foreground">Retry</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                <div>
                  <div className="text-lg font-bold">{batch.flagged_count}</div>
                  <p className="text-xs text-muted-foreground">Flagged</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border p-3">
                <XCircle className="h-5 w-5 text-red-500" />
                <div>
                  <div className="text-lg font-bold">{batch.error_count}</div>
                  <p className="text-xs text-muted-foreground">Errores</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Launch Button */}
      <div className="flex justify-center">
        <Button
          size="lg"
          onClick={handleGenerate}
          disabled={generating || selectedCount === 0 || selectedSwatchCount === 0}
          className="px-12"
        >
          {generating ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Generando...
            </>
          ) : (
            <>
              <Play className="mr-2 h-5 w-5" />
              Iniciar Pipeline ({totalCombinations} imagenes)
            </>
          )}
        </Button>
      </div>

      {swatches.length === 0 && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Necesitas subir al menos 1 swatch.{' '}
          <Link href={`/projects/${id}/swatches`} className="text-blue-600 hover:underline">
            Subir swatches
          </Link>
        </p>
      )}
    </div>
  );
}

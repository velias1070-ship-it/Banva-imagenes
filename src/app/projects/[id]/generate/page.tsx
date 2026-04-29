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
import { ArrowLeft, Play, Loader2, CheckCircle, AlertTriangle, XCircle, ImageIcon, StopCircle } from 'lucide-react';
import type { Swatch, GenerationBatch } from '@/types/database';
import { COST_PER_IMAGE_USD } from '@/lib/constants';
import { toast } from 'sonner';
import {
  anyHeroHasTags,
  extractSizeFromSku,
  resolveHeroForVariant,
  type ProjectVariant,
} from '@/lib/sku-parser';

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
  applies_to_designs: string[] | null;
  applies_to_sizes: string[] | null;
}

export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const [heroesWithStatus, setHeroesWithStatus] = useState<HeroWithStatus[]>([]);
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [variantes, setVariantes] = useState<ProjectVariant[]>([]);
  const [selectedHeroIds, setSelectedHeroIds] = useState<Set<string>>(new Set());
  const [selectedSwatchIds, setSelectedSwatchIds] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<GenerationBatch | null>(null);
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [brandHeroIds, setBrandHeroIds] = useState<Set<string>>(new Set()); // heroes that will use brand
  const [hasBrand, setHasBrand] = useState(false);
  const [swatchStatus, setSwatchStatus] = useState<Record<string, { status: string; available_quantity: number; item_id: string }>>({});
  const [missingVariants, setMissingVariants] = useState<Array<{ item_id: string; title: string; seller_sku: string; status: string; available_quantity: number }>>([]);
  const [loadingMissing, setLoadingMissing] = useState(false);
  const [addingMissing, setAddingMissing] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);

  const fetchData = useCallback(async () => {
    const [heroStatusRes, swatchRes] = await Promise.all([
      fetch(`/api/projects/${id}/generate?with_meta=1`),
      fetch(`/api/projects/${id}/swatches`),
    ]);
    if (heroStatusRes.ok) {
      const payload = await heroStatusRes.json();
      const heroData: HeroWithStatus[] = Array.isArray(payload) ? payload : payload.heroes;
      setHeroesWithStatus(heroData);
      if (!Array.isArray(payload) && Array.isArray(payload.variantes)) {
        setVariantes(payload.variantes as ProjectVariant[]);
      }
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
      setSelectedSwatchIds(new Set(swatchData.map((s) => s.id)));
    }
    // Check if project has brand
    const projRes = await fetch(`/api/projects/${id}`);
    if (projRes.ok) {
      const proj = await projRes.json();
      if (proj.brand_id) {
        setHasBrand(true);
        // Brand OFF by default — user opts in per hero via checkbox
        setBrandHeroIds(new Set());
      }
    }
  }, [id]);

  useEffect(() => {
    fetchData();
    // Fetch ML status/stock for swatches
    fetch(`/api/projects/${id}/swatches-status`)
      .then((r) => r.ok ? r.json() : {})
      .then(setSwatchStatus)
      .catch(() => {});
    // Check for missing variants
    setLoadingMissing(true);
    fetch(`/api/projects/${id}/missing-variants`)
      .then((r) => r.ok ? r.json() : { missing: [] })
      .then((data) => setMissingVariants(data.missing || []))
      .catch(() => {})
      .finally(() => setLoadingMissing(false));
  }, [fetchData, id]);

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
        } else if (updated.status === 'halted') {
          // Halt may come from user-stop (no active generating jobs) or auto-halt (>20% flagged)
          const stillRunning = (updated.total_combinations ?? 0) > (updated.completed_count ?? 0) + (updated.error_count ?? 0);
          if (!stillRunning) {
            setGenerating(false);
          }
        } else if (updated.status === 'failed') {
          toast.error('La generacion tuvo errores');
          setGenerating(false);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [batch, fetchData]);

  // Auto-healing: call per-batch health check every 30s to relaunch broken chains
  // The health endpoint detects stale jobs (>60s without update) and relaunches chains.
  // Combined with dual-dispatch in process-next/process-qa, this ensures chains never stay broken.
  useEffect(() => {
    if (!batch || batch.status === 'completed' || batch.status === 'failed') return;

    const healthInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/batches/${batch.id}/health`);
        if (res.ok) {
          const data = await res.json();
          if (data.actions?.length > 0) {
            console.log('[auto-heal] Chains relaunched:', data.actions);
          }
        }
      } catch {
        // Silently ignore — health check is best-effort
      }
    }, 30_000); // every 30 seconds

    // Also run once at 15s (catches early chain breaks)
    const initialTimeout = setTimeout(async () => {
      try {
        await fetch(`/api/batches/${batch.id}/health`);
      } catch {
        // ignore
      }
    }, 15_000);

    return () => {
      clearInterval(healthInterval);
      clearTimeout(initialTimeout);
    };
  }, [batch]);

  const selectedCount = selectedHeroIds.size;
  const selectedSwatchCount = selectedSwatchIds.size;

  const resolverPreview = useMemo(() => {
    const selectedHeroes = heroesWithStatus.filter((h) => selectedHeroIds.has(h.id));
    const useResolver = variantes.length > 0 && anyHeroHasTags(selectedHeroes);
    if (!useResolver) {
      return {
        useResolver: false,
        total: selectedCount * selectedSwatchCount,
        skipped: [] as { sku?: string; name: string }[],
        breakdown: { exact: 0, design_only: 0, size_only: 0, generic: 0 },
        assignments: [] as Array<{
          swatch: Swatch;
          hero: HeroWithStatus | null;
          tier: 'exact' | 'design_only' | 'size_only' | 'generic' | 'none';
          design: string | null;
          size: string | null;
        }>,
      };
    }
    const variantBySku = new Map(variantes.map((v) => [v.sku.toUpperCase(), v]));
    const selectedSwatches = swatches.filter((s) => selectedSwatchIds.has(s.id));
    const breakdown = { exact: 0, design_only: 0, size_only: 0, generic: 0 };
    const skipped: { sku?: string; name: string }[] = [];
    const assignments: Array<{
      swatch: Swatch;
      hero: HeroWithStatus | null;
      tier: 'exact' | 'design_only' | 'size_only' | 'generic' | 'none';
      design: string | null;
      size: string | null;
    }> = [];
    let total = 0;
    for (const sw of selectedSwatches) {
      const sku = (sw.sku_suffix || '').toUpperCase();
      const variant = sku ? variantBySku.get(sku) : undefined;
      const design = variant?.color_slug || null;
      const size = sku ? extractSizeFromSku(sku) : null;
      const r = resolveHeroForVariant(selectedHeroes, design, size);
      if (!r) {
        skipped.push({ sku: sw.sku_suffix || undefined, name: sw.name });
        assignments.push({ swatch: sw, hero: null, tier: 'none', design, size });
        continue;
      }
      if (r.tier !== 'none') breakdown[r.tier as keyof typeof breakdown]++;
      total++;
      assignments.push({ swatch: sw, hero: r.hero, tier: r.tier, design, size });
    }
    return { useResolver: true, total, skipped, breakdown, assignments };
  }, [heroesWithStatus, swatches, variantes, selectedHeroIds, selectedSwatchIds, selectedCount, selectedSwatchCount]);

  const totalCombinations = resolverPreview.total;
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

  async function handleStopGeneration() {
    if (!batch || stopping) return;
    const confirmed = window.confirm(
      '¿Detener esta generación?\n\n' +
      'Se cancelan los jobs pendientes inmediatamente. Los que ya estén ejecutando Gemini ' +
      '(≈25s) terminan solos y suben su resultado normalmente.',
    );
    if (!confirmed) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/batches/${batch.id}/stop`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const parts = [`${data.cancelled_pending} canceladas`];
        if (data.in_flight > 0) parts.push(`${data.in_flight} en vuelo (~25s)`);
        if (data.qa_draining > 0) parts.push(`${data.qa_draining} en QA`);
        toast.success(`Detenido — ${parts.join(', ')}`);
      } else {
        toast.error(data.error || 'No se pudo detener');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setStopping(false);
    }
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
          skip_brand_hero_ids: Array.from(selectedHeroIds).filter((hId) => !brandHeroIds.has(hId)),
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

                    {/* Brand toggle */}
                    {hasBrand && isSelected && (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={brandHeroIds.has(hero.id)}
                          onCheckedChange={(checked) => {
                            setBrandHeroIds((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(hero.id); else next.delete(hero.id);
                              return next;
                            });
                          }}
                        />
                        <span className="text-[11px] text-muted-foreground">Brand</span>
                      </div>
                    )}

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

      {/* Missing Variants Alert */}
      {missingVariants.length > 0 && (
        <Card className="mb-6 border-amber-300 bg-amber-50">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-amber-800">
                  <AlertTriangle className="h-4 w-4 inline mr-1" />
                  {missingVariants.length} publicaciones activas en ML no estan en este proyecto:
                </p>
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                  {missingVariants.map((v) => (
                    <div key={v.item_id} className="text-xs text-amber-700 flex items-center gap-2">
                      <span className={v.status === 'active' ? 'text-green-600' : 'text-red-500'}>●</span>
                      <span className="font-mono">{v.seller_sku}</span>
                      <span className="truncate">{v.title}</span>
                      <span className="text-amber-500">stk: {v.available_quantity}</span>
                    </div>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 flex-shrink-0"
                disabled={addingMissing}
                onClick={async () => {
                  setAddingMissing(true);
                  try {
                    const res = await fetch(`/api/projects/${id}/missing-variants`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ skus: missingVariants.map((v) => v.seller_sku) }),
                    });
                    if (res.ok) {
                      const data = await res.json();
                      toast.success(`${data.added} variantes agregadas`);
                      setMissingVariants([]);
                      fetchData();
                    }
                  } catch { toast.error('Error'); }
                  finally { setAddingMissing(false); }
                }}
              >
                {addingMissing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Agregar {missingVariants.length} faltantes
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {loadingMissing && (
        <div className="mb-4 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Verificando variantes en MercadoLibre...
        </div>
      )}

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
                    {swatchStatus[swatch.id] && (
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className={swatchStatus[swatch.id].status === 'active' ? 'text-green-600' : 'text-red-500'}>
                          {swatchStatus[swatch.id].status === 'active' ? '●' : '○'} {swatchStatus[swatch.id].status}
                        </span>
                        <span className={`font-mono ${swatchStatus[swatch.id].available_quantity === 0 ? 'text-red-600 font-bold' : 'text-muted-foreground'}`}>
                          stk: {swatchStatus[swatch.id].available_quantity}
                        </span>
                      </div>
                    )}
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

          {resolverPreview.useResolver && (
            <div className="mt-4 rounded border border-indigo-200 bg-indigo-50 p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium text-indigo-900">
                  Modo resolver activo · 1 hero por swatch (no cross product)
                </div>
                <button
                  type="button"
                  onClick={() => setShowAssignments((v) => !v)}
                  className="text-indigo-700 underline hover:text-indigo-900"
                >
                  {showAssignments ? 'Ocultar' : 'Ver'} asignaciones
                </button>
              </div>
              <div className="mt-1 text-indigo-800">
                Match por SKU →{' '}
                <span className="font-medium">{resolverPreview.breakdown.exact}</span> exact ·{' '}
                <span className="font-medium">{resolverPreview.breakdown.design_only}</span> solo diseño ·{' '}
                <span className="font-medium">{resolverPreview.breakdown.size_only}</span> solo tamaño ·{' '}
                <span className="font-medium">{resolverPreview.breakdown.generic}</span> genérico
              </div>
              {resolverPreview.skipped.length > 0 && (
                <div className="mt-2 text-amber-800">
                  <span className="font-medium">{resolverPreview.skipped.length}</span> swatch(es) sin hero
                  compatible (saltean): {resolverPreview.skipped.slice(0, 5).map((s) => s.name).join(', ')}
                  {resolverPreview.skipped.length > 5 ? '…' : ''}
                </div>
              )}

              {showAssignments && (
                <div className="mt-3 max-h-96 overflow-auto rounded border border-indigo-100 bg-white">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-indigo-50">
                      <tr className="text-left text-indigo-900">
                        <th className="p-2">Swatch</th>
                        <th className="p-2">SKU</th>
                        <th className="p-2">Diseño</th>
                        <th className="p-2">Tamaño</th>
                        <th className="p-2">→ Hero asignado</th>
                        <th className="p-2">Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...resolverPreview.assignments]
                        .sort((a, b) => {
                          const order = { exact: 0, design_only: 1, size_only: 2, generic: 3, none: 4 };
                          return order[a.tier] - order[b.tier];
                        })
                        .map((a) => {
                          const tierColor = {
                            exact: 'bg-emerald-100 text-emerald-900',
                            design_only: 'bg-cyan-100 text-cyan-900',
                            size_only: 'bg-amber-100 text-amber-900',
                            generic: 'bg-indigo-100 text-indigo-900',
                            none: 'bg-rose-100 text-rose-900',
                          }[a.tier];
                          return (
                            <tr key={a.swatch.id} className="border-t border-indigo-50">
                              <td className="p-2">
                                <div className="flex items-center gap-2">
                                  <div className="h-8 w-8 overflow-hidden rounded bg-gray-100">
                                    {a.swatch.storage_path && (
                                      <img
                                        src={getStorageUrl(a.swatch.storage_path)}
                                        alt={a.swatch.name}
                                        className="h-full w-full object-cover"
                                      />
                                    )}
                                  </div>
                                  <span>{a.swatch.name}</span>
                                </div>
                              </td>
                              <td className="p-2 font-mono text-[10px]">{a.swatch.sku_suffix || '—'}</td>
                              <td className="p-2">{a.design || '—'}</td>
                              <td className="p-2">{a.size || '—'}</td>
                              <td className="p-2">
                                {a.hero ? (
                                  <div className="flex items-center gap-2">
                                    <div className="h-8 w-8 overflow-hidden rounded bg-gray-100">
                                      <img
                                        src={getStorageUrl(a.hero.storage_path)}
                                        alt={a.hero.filename}
                                        className="h-full w-full object-cover"
                                      />
                                    </div>
                                    <span className="truncate max-w-[180px]">{a.hero.filename}</span>
                                  </div>
                                ) : (
                                  <span className="text-rose-700">— skipea —</span>
                                )}
                              </td>
                              <td className="p-2">
                                <span className={`rounded px-1.5 py-0.5 text-[10px] ${tierColor}`}>{a.tier}</span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

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
              <div className="flex items-center gap-2">
                {['pending', 'generating', 'qa', 'retrying'].includes(batch.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStopGeneration}
                    disabled={stopping}
                    className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                  >
                    {stopping ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <StopCircle className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {stopping ? 'Deteniendo...' : 'Detener'}
                  </Button>
                )}
                <Badge
                  variant={
                    batch.status === 'completed'
                      ? 'default'
                      : batch.status === 'failed'
                      ? 'destructive'
                      : batch.status === 'halted'
                      ? 'destructive'
                      : 'secondary'
                  }
                >
                  {batch.status}
                </Badge>
              </div>
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

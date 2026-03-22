'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Download, CheckCircle, AlertTriangle, XCircle,
  ImageIcon, RotateCcw, LayoutGrid, Layers, ChevronDown, ChevronRight,
  Upload, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface JobWithRelations {
  id: string;
  status: string;
  attempt: number;
  output_storage_path: string | null;
  qa_score: number | null;
  qa_feedback: string | null;
  qa_detail: {
    product_fidelity?: number;
    hero_contamination?: number;
    [key: string]: number | undefined;
  } | null;
  error_message: string | null;
  hero_shot: { filename: string; shot_type: string; storage_path: string } | null;
  swatch: { id: string; name: string; color_description: string | null; storage_path: string; display_order: number } | null;
}

interface SwatchGroup {
  swatchId: string;
  swatchName: string;
  colorDescription: string | null;
  swatchStoragePath: string;
  displayOrder: number;
  jobs: JobWithRelations[];
}

function getStorageUrl(path: string, attempt?: number): string {
  const cacheBuster = attempt ? `?v=${attempt}` : '';
  return `${SUPABASE_URL}/storage/v1/object/public/images/${path}${cacheBuster}`;
}

type FilterTab = 'all' | 'approved' | 'retry' | 'flagged' | 'error' | 'qa_pending';
type ViewMode = 'grid' | 'grouped';

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('banva-results-view') as ViewMode) || 'grouped';
    }
    return 'grouped';
  });
  const [collapsedSwatches, setCollapsedSwatches] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    success: number; errors: number; skipped: number; total_images: number;
    total_new_images?: number; total_kept_images?: number;
    details?: { sku: string; item_id: string; titulo: string; status: string; error?: string; pictures_new?: number; pictures_kept?: number; pictures_total?: number }[];
  } | null>(null);

  const fetchResults = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/results`);
    if (res.ok) {
      setJobs(await res.json());
    }
  }, [id]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // ── AUTO-POLL + HEALTH CHECK: keeps chains alive while jobs are active ──
  const hasActiveJobs = jobs.some((j) =>
    ['pending', 'generating', 'qa_pending', 'qa_processing'].includes(j.status)
  );

  useEffect(() => {
    if (!hasActiveJobs) return;

    // Poll results every 10s
    const pollInterval = setInterval(fetchResults, 10_000);

    // Trigger health check every 30s to auto-recover stale chains
    const healthInterval = setInterval(() => {
      fetch(`/api/cron/health-check?project_id=${id}`).catch(() => {});
    }, 30_000);

    // Also trigger immediately on mount
    fetch(`/api/cron/health-check?project_id=${id}`).catch(() => {});

    return () => {
      clearInterval(pollInterval);
      clearInterval(healthInterval);
    };
  }, [hasActiveJobs, fetchResults, id]);

  const filtered = activeTab === 'all'
    ? jobs
    : activeTab === 'qa_pending'
      ? jobs.filter((j) => j.status === 'qa_pending' || j.status === 'qa_processing')
      : jobs.filter((j) => j.status === activeTab);

  const approvedCount = jobs.filter((j) => j.status === 'approved').length;
  const retryCount = jobs.filter((j) => j.status === 'retry').length;
  const flaggedCount = jobs.filter((j) => j.status === 'flagged').length;
  const errorCount = jobs.filter((j) => j.status === 'error').length;
  const qaPendingCount = jobs.filter((j) => j.status === 'qa_pending' || j.status === 'qa_processing').length;

  // Group filtered jobs by swatch
  const groupedBySwatch = useMemo<SwatchGroup[]>(() => {
    const map = new Map<string, SwatchGroup>();

    for (const job of filtered) {
      const swatchId = job.swatch?.id ?? '__unknown__';
      if (!map.has(swatchId)) {
        map.set(swatchId, {
          swatchId,
          swatchName: job.swatch?.name ?? 'Sin variante',
          colorDescription: job.swatch?.color_description ?? null,
          swatchStoragePath: job.swatch?.storage_path ?? '',
          displayOrder: job.swatch?.display_order ?? 999,
          jobs: [],
        });
      }
      map.get(swatchId)!.jobs.push(job);
    }

    return Array.from(map.values()).sort((a, b) => a.displayOrder - b.displayOrder);
  }, [filtered]);

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem('banva-results-view', mode);
  }

  function toggleSwatchCollapse(swatchId: string) {
    setCollapsedSwatches((prev) => {
      const next = new Set(prev);
      if (next.has(swatchId)) {
        next.delete(swatchId);
      } else {
        next.add(swatchId);
      }
      return next;
    });
  }

  async function handleDownloadAll() {
    toast.info('Preparando descarga ZIP...');
    try {
      const res = await fetch(`/api/projects/${id}/download`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `banva-project-${id}-approved.zip`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Descarga iniciada');
      } else {
        toast.error('Error preparando descarga');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleRegenerate(jobId: string) {
    toast.info('Regenerando imagen...');
    try {
      const res = await fetch(`/api/projects/${id}/results/${jobId}`, {
        method: 'POST',
      });
      if (res.ok) {
        setJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, status: 'generating' } : j))
        );
        toast.success('Regenerando — se actualizara automaticamente');
        const poll = setInterval(async () => {
          const updated = await fetch(`/api/projects/${id}/results`);
          if (updated.ok) {
            const allJobs = await updated.json();
            const thisJob = allJobs.find((j: JobWithRelations) => j.id === jobId);
            setJobs(allJobs);
            if (thisJob && thisJob.status !== 'generating' && thisJob.status !== 'qa_pending' && thisJob.status !== 'qa_processing') {
              clearInterval(poll);
              if (thisJob.status === 'approved') {
                toast.success('Imagen regenerada y aprobada por QA');
              } else if (thisJob.status === 'flagged') {
                toast.error('Imagen regenerada pero rechazada por QA');
              } else {
                toast.error(`Regeneracion termino con estado: ${thisJob.status}`);
              }
            }
          }
        }, 5000);
      } else {
        toast.error('Error iniciando regeneracion');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleDownloadOne(jobId: string) {
    try {
      const res = await fetch(`/api/projects/${id}/download?jobId=${jobId}`);
      if (res.ok) {
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition');
        const match = disposition?.match(/filename="(.+)"/);
        const filename = match?.[1] || `${jobId}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.error('Error descargando imagen');
      }
    } catch {
      toast.error('Error de conexion');
    }
  }

  async function handleOverride(jobId: string, newStatus: 'approved' | 'flagged') {
    const res = await fetch(`/api/projects/${id}/results/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (res.ok) {
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: newStatus } : j))
      );
      toast.success(`Imagen ${newStatus === 'approved' ? 'aprobada' : 'rechazada'}`);
    }
  }

  async function handlePublishToML(dryRun: boolean, mode: 'prepend' | 'append' | 'replace' = 'prepend') {
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await fetch('/api/ml/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: id, dry_run: dryRun, mode }),
      });
      const data = await res.json();
      if (res.ok) {
        setPublishResult(data);
        if (dryRun) {
          toast.info(`Preview: ${data.total_new_images} nuevas + ${data.total_kept_images} existentes en ${data.success} publicaciones`);
        } else {
          if (data.errors > 0) {
            toast.error(`Publicado con ${data.errors} errores. ${data.success} exitosos.`);
          } else {
            toast.success(`${data.total_new_images} imagenes nuevas publicadas en ${data.success} publicaciones de ML (${data.total_kept_images} existentes mantenidas)`);
          }
        }
      } else {
        toast.error(data.error || 'Error publicando');
      }
    } catch {
      toast.error('Error de conexion');
    } finally {
      setPublishing(false);
    }
  }

  function statusIcon(status: string) {
    switch (status) {
      case 'approved':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'retry':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'flagged':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'qa_pending':
      case 'qa_processing':
        return <RotateCcw className="h-4 w-4 text-purple-500 animate-spin" />;
      case 'generating':
        return <RotateCcw className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return null;
    }
  }

  // ---- Reusable JobCard ----
  function JobCard({ job }: { job: JobWithRelations }) {
    return (
      <Card className="overflow-hidden">
        <div className="aspect-square bg-gray-100 relative">
          {job.output_storage_path ? (
            <img
              src={getStorageUrl(job.output_storage_path, job.attempt)}
              alt={job.swatch?.name || 'Generated image'}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-gray-400">
              {job.status === 'error' ? job.error_message || 'Error' : 'Sin imagen'}
            </div>
          )}
        </div>
        <CardContent className="p-3">
          <div className="mb-2">
            <p className="text-sm font-medium truncate">{job.swatch?.name || 'Variante'}</p>
            <p className="text-xs text-muted-foreground truncate">
              {job.hero_shot?.filename || 'Hero'} &middot; {job.hero_shot?.shot_type}
            </p>
          </div>

          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {statusIcon(job.status)}
              <Badge
                variant={
                  job.status === 'approved' ? 'default' :
                  job.status === 'error' ? 'destructive' : 'secondary'
                }
                className="text-xs"
              >
                {job.status}
              </Badge>
            </div>
            {job.qa_score !== null && (
              <span
                className="text-xs font-medium cursor-help"
                title={job.qa_feedback || 'Sin feedback'}
              >
                QA: {(job.qa_score * 100).toFixed(0)}%
                {job.qa_detail?.hero_contamination != null && job.qa_detail.hero_contamination > 0.3 && (
                  <span className="ml-1 text-orange-500" title={`Hero contamination: ${(job.qa_detail.hero_contamination * 100).toFixed(0)}%`}>
                    !
                  </span>
                )}
              </span>
            )}
            {(job.status === 'qa_pending' || job.status === 'qa_processing') && (
              <span className="text-xs text-purple-600 flex items-center gap-1">
                <RotateCcw className="h-3 w-3 animate-spin" />
                QA...
              </span>
            )}
          </div>

          {job.qa_feedback && job.status !== 'approved' && (
            <p className="text-xs text-muted-foreground mb-2 line-clamp-2" title={job.qa_feedback}>
              {job.qa_feedback}
            </p>
          )}

          {job.status === 'generating' && (
            <div className="flex items-center gap-2 text-xs text-blue-600">
              <RotateCcw className="h-3 w-3 animate-spin" />
              Generando...
            </div>
          )}
          {(job.status === 'qa_pending' || job.status === 'qa_processing') && (
            <div className="flex items-center gap-2 text-xs text-purple-600">
              <RotateCcw className="h-3 w-3 animate-spin" />
              QA en progreso...
            </div>
          )}
          {job.status !== 'pending' && job.status !== 'generating' && job.status !== 'qa_pending' && job.status !== 'qa_processing' && (
            <div className="flex gap-1.5">
              {job.output_storage_path && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleDownloadOne(job.id)}
                >
                  <Download className="h-3 w-3" />
                </Button>
              )}
              {(job.status === 'flagged' || job.status === 'error') && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-blue-600"
                  onClick={() => handleRegenerate(job.id)}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Regenerar
                </Button>
              )}
              {job.status !== 'approved' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs text-green-600"
                  onClick={() => handleOverride(job.id, 'approved')}
                >
                  Aprobar
                </Button>
              )}
              {job.status !== 'flagged' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs text-red-600"
                  onClick={() => handleOverride(job.id, 'flagged')}
                >
                  Rechazar
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---- Render ----
  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al Proyecto
      </Link>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Resultados</h1>
          <p className="text-muted-foreground">
            {jobs.length} imagenes generadas &middot; {approvedCount} aprobadas
          </p>
        </div>
        {approvedCount > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={handleDownloadAll}>
              <Download className="mr-2 h-4 w-4" />
              ZIP ({approvedCount})
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePublishToML(true, 'prepend')}
              disabled={publishing}
            >
              {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Preview ML
            </Button>
            <Button
              onClick={() => handlePublishToML(false, 'prepend')}
              disabled={publishing}
              title="Agrega las nuevas al inicio, mantiene las existentes despues"
            >
              {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Publicar (nuevas primero)
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePublishToML(false, 'append')}
              disabled={publishing}
              title="Mantiene las existentes, agrega las nuevas al final"
            >
              Agregar al final
            </Button>
          </div>
        )}
      </div>

      {/* Publish result panel */}
      {publishResult && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">
                {publishResult.details?.[0]?.status === 'success' && !publishing
                  ? 'Resultado de publicacion'
                  : 'Preview de publicacion'}
              </h3>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setPublishResult(null)}>
                Cerrar
              </Button>
            </div>
            <div className="flex gap-4 text-sm mb-3 flex-wrap">
              <span className="text-green-600">{publishResult.success} exitosos</span>
              {publishResult.errors > 0 && <span className="text-red-600">{publishResult.errors} errores</span>}
              {publishResult.skipped > 0 && <span className="text-yellow-600">{publishResult.skipped} omitidos</span>}
              <span className="text-muted-foreground">{publishResult.total_images} imagenes total</span>
            </div>
            {publishResult.details && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {publishResult.details.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 border-t">
                    {d.status === 'success' ? (
                      <CheckCircle className="h-3 w-3 text-green-500 flex-shrink-0" />
                    ) : d.status === 'error' ? (
                      <XCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-yellow-500 flex-shrink-0" />
                    )}
                    <span className="font-mono">{d.sku}</span>
                    <span className="text-muted-foreground truncate">{d.titulo || d.item_id}</span>
                    {d.error && <span className="text-red-500 truncate ml-auto">{d.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FilterTab)}>
        {/* View toggle + Tabs */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="all">Todas ({jobs.length})</TabsTrigger>
            <TabsTrigger value="approved">Aprobadas ({approvedCount})</TabsTrigger>
            <TabsTrigger value="retry">Retry ({retryCount})</TabsTrigger>
            <TabsTrigger value="flagged">Flagged ({flaggedCount})</TabsTrigger>
            <TabsTrigger value="qa_pending">QA ({qaPendingCount})</TabsTrigger>
            <TabsTrigger value="error">Errores ({errorCount})</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            {viewMode === 'grouped' && groupedBySwatch.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  if (collapsedSwatches.size === groupedBySwatch.length) {
                    setCollapsedSwatches(new Set());
                  } else {
                    setCollapsedSwatches(new Set(groupedBySwatch.map((g) => g.swatchId)));
                  }
                }}
              >
                {collapsedSwatches.size === groupedBySwatch.length ? 'Expandir todo' : 'Colapsar todo'}
              </Button>
            )}
            <div className="flex items-center gap-0.5 rounded-lg border p-0.5 bg-muted">
              <Button
                variant={viewMode === 'grid' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 gap-1.5 text-xs px-2.5"
                onClick={() => handleViewModeChange('grid')}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Grilla
              </Button>
              <Button
                variant={viewMode === 'grouped' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 gap-1.5 text-xs px-2.5"
                onClick={() => handleViewModeChange('grouped')}
              >
                <Layers className="h-3.5 w-3.5" />
                Por Variante
              </Button>
            </div>
          </div>
        </div>

        <TabsContent value={activeTab}>
          {filtered.length === 0 ? (
            <Card>
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center text-center">
                  <ImageIcon className="mb-4 h-12 w-12 text-muted-foreground/50" />
                  <p className="text-muted-foreground">
                    {jobs.length === 0
                      ? 'No hay resultados aun. Genera variantes primero.'
                      : 'No hay imagenes en esta categoria'}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : viewMode === 'grid' ? (
            /* ---- FLAT GRID VIEW ---- */
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {filtered.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          ) : (
            /* ---- GROUPED BY SWATCH VIEW ---- */
            <div className="space-y-4">
              {groupedBySwatch.map((group) => {
                const isCollapsed = collapsedSwatches.has(group.swatchId);
                const approvedInGroup = group.jobs.filter((j) => j.status === 'approved').length;

                return (
                  <div key={group.swatchId} className="rounded-xl border bg-card shadow-sm overflow-hidden">
                    {/* Section header */}
                    <button
                      onClick={() => toggleSwatchCollapse(group.swatchId)}
                      className="w-full flex items-center gap-4 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                    >
                      {/* Swatch thumbnail */}
                      {group.swatchStoragePath ? (
                        <div className="h-14 w-14 flex-shrink-0 rounded-lg overflow-hidden border bg-gray-100">
                          <img
                            src={getStorageUrl(group.swatchStoragePath)}
                            alt={group.swatchName}
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="h-14 w-14 flex-shrink-0 rounded-lg border bg-gray-100 flex items-center justify-center">
                          <ImageIcon className="h-6 w-6 text-gray-300" />
                        </div>
                      )}

                      {/* Swatch info */}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm leading-tight truncate">{group.swatchName}</p>
                        {group.colorDescription && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{group.colorDescription}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {group.jobs.length} imagen{group.jobs.length !== 1 ? 'es' : ''}
                          {approvedInGroup > 0 && (
                            <span className="text-green-600"> &middot; {approvedInGroup} aprobada{approvedInGroup !== 1 ? 's' : ''}</span>
                          )}
                        </p>
                      </div>

                      {/* Status summary badges */}
                      <div className="flex-shrink-0 flex items-center gap-1.5">
                        {approvedInGroup === group.jobs.length ? (
                          <Badge variant="default" className="text-xs bg-green-100 text-green-700 border-green-200">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Completo
                          </Badge>
                        ) : approvedInGroup > 0 ? (
                          <Badge variant="secondary" className="text-xs">
                            {approvedInGroup}/{group.jobs.length}
                          </Badge>
                        ) : null}
                      </div>

                      {/* Collapse chevron */}
                      <div className="flex-shrink-0 text-muted-foreground">
                        {isCollapsed
                          ? <ChevronRight className="h-5 w-5" />
                          : <ChevronDown className="h-5 w-5" />}
                      </div>
                    </button>

                    {/* Section body — collapsible */}
                    {!isCollapsed && (
                      <div className="px-4 pb-4 border-t">
                        <div className="grid gap-3 pt-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                          {group.jobs.map((job) => (
                            <JobCard key={job.id} job={job} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

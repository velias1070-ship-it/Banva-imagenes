'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Download, CheckCircle, AlertTriangle, XCircle, ImageIcon, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface JobWithRelations {
  id: string;
  status: string;
  output_storage_path: string | null;
  qa_score: number | null;
  error_message: string | null;
  hero_shot: { filename: string; shot_type: string; storage_path: string } | null;
  swatch: { name: string; color_description: string | null; storage_path: string } | null;
}

function getStorageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/images/${path}`;
}

type FilterTab = 'all' | 'approved' | 'retry' | 'flagged' | 'error';

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');

  const fetchResults = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/results`);
    if (res.ok) {
      setJobs(await res.json());
    }
  }, [id]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const filtered = activeTab === 'all'
    ? jobs
    : jobs.filter((j) => j.status === activeTab);

  const approvedCount = jobs.filter((j) => j.status === 'approved').length;
  const retryCount = jobs.filter((j) => j.status === 'retry').length;
  const flaggedCount = jobs.filter((j) => j.status === 'flagged').length;
  const errorCount = jobs.filter((j) => j.status === 'error').length;

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
        toast.success('Regenerando — se actualizará automáticamente');
        // Poll for completion
        const poll = setInterval(async () => {
          const updated = await fetch(`/api/projects/${id}/results`);
          if (updated.ok) {
            const allJobs = await updated.json();
            const thisJob = allJobs.find((j: JobWithRelations) => j.id === jobId);
            if (thisJob && thisJob.status !== 'generating') {
              setJobs(allJobs);
              clearInterval(poll);
              if (thisJob.status === 'approved') {
                toast.success('Imagen regenerada correctamente');
              } else {
                toast.error(`Regeneración terminó con estado: ${thisJob.status}`);
              }
            }
          }
        }, 5000);
      } else {
        toast.error('Error iniciando regeneración');
      }
    } catch {
      toast.error('Error de conexión');
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
      default:
        return null;
    }
  }

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
          <Button onClick={handleDownloadAll}>
            <Download className="mr-2 h-4 w-4" />
            Descargar Aprobadas ({approvedCount})
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FilterTab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="all">Todas ({jobs.length})</TabsTrigger>
          <TabsTrigger value="approved">Aprobadas ({approvedCount})</TabsTrigger>
          <TabsTrigger value="retry">Retry ({retryCount})</TabsTrigger>
          <TabsTrigger value="flagged">Flagged ({flaggedCount})</TabsTrigger>
          <TabsTrigger value="error">Errores ({errorCount})</TabsTrigger>
        </TabsList>

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
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {filtered.map((job) => (
                <Card key={job.id} className="overflow-hidden">
                  <div className="aspect-square bg-gray-100 relative">
                    {job.output_storage_path ? (
                      <img
                        src={getStorageUrl(job.output_storage_path)}
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
                    {/* Swatch + Hero info */}
                    <div className="mb-2">
                      <p className="text-sm font-medium truncate">{job.swatch?.name || 'Variante'}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {job.hero_shot?.filename || 'Hero'} · {job.hero_shot?.shot_type}
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
                        <span className="text-xs font-medium">
                          QA: {(job.qa_score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>

                    {/* Actions */}
                    {job.status === 'generating' && (
                      <div className="flex items-center gap-2 text-xs text-blue-600">
                        <RotateCcw className="h-3 w-3 animate-spin" />
                        Regenerando...
                      </div>
                    )}
                    {job.status !== 'pending' && job.status !== 'generating' && (
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
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

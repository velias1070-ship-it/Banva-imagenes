import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Upload, Play, ImageIcon } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';

interface Props {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (!project) notFound();

  const [{ count: heroCount }, { count: swatchCount }, { data: latestBatch }] = await Promise.all([
    supabase.from('hero_shots').select('*', { count: 'exact', head: true }).eq('project_id', id),
    supabase.from('swatches').select('*', { count: 'exact', head: true }).eq('project_id', id),
    supabase.from('generation_batches').select('approved_count').eq('project_id', id).order('created_at', { ascending: false }).limit(1),
  ]);

  const heroes = heroCount || 0;
  const swatches = swatchCount || 0;
  const approved = latestBatch?.[0]?.approved_count || 0;

  return (
    <div className="p-8">
      <Link href="/projects" className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver a Proyectos
      </Link>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-muted-foreground">{project.category}{project.sku_base ? ` · ${project.sku_base}` : ''}</p>
        </div>
        <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
          {project.status}
        </Badge>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Link href={`/projects/${id}/heroes`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <Upload className="h-8 w-8 text-blue-500" />
              <div>
                <CardTitle className="text-base">Hero Shots</CardTitle>
                <p className="text-sm text-muted-foreground">Subir imagenes base</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{heroes}</div>
              <p className="text-xs text-muted-foreground">imagenes</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/projects/${id}/swatches`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <Upload className="h-8 w-8 text-purple-500" />
              <div>
                <CardTitle className="text-base">Swatches</CardTitle>
                <p className="text-sm text-muted-foreground">Subir variantes</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{swatches}</div>
              <p className="text-xs text-muted-foreground">variantes</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/projects/${id}/generate`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <Play className="h-8 w-8 text-green-500" />
              <div>
                <CardTitle className="text-base">Generar</CardTitle>
                <p className="text-sm text-muted-foreground">Lanzar pipeline</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{heroes} x {swatches}</div>
              <p className="text-xs text-muted-foreground">= {heroes * swatches} imagenes</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/projects/${id}/results`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader className="flex flex-row items-center gap-3">
              <ImageIcon className="h-8 w-8 text-amber-500" />
              <div>
                <CardTitle className="text-base">Resultados</CardTitle>
                <p className="text-sm text-muted-foreground">Galeria + descarga</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{approved}</div>
              <p className="text-xs text-muted-foreground">aprobadas</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}

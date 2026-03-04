import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FolderPlus, ImageIcon } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import type { Project } from '@/types/database';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const supabase = await createServerSupabase();

  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });

  const projectList = (projects || []) as Project[];

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Proyectos</h1>
          <p className="text-muted-foreground">Todos tus productos ({projectList.length})</p>
        </div>
        <Link href="/projects/new">
          <Button>
            <FolderPlus className="mr-2 h-4 w-4" />
            Nuevo Proyecto
          </Button>
        </Link>
      </div>

      {projectList.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <ImageIcon className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">No hay proyectos aun</p>
              <Link href="/projects/new" className="mt-4">
                <Button variant="outline">Crear primer proyecto</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projectList.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold">{project.name}</h3>
                      <p className="text-sm text-muted-foreground">{project.category}</p>
                    </div>
                    <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                      {project.status}
                    </Badge>
                  </div>
                  {project.sku_base && (
                    <p className="mt-2 text-xs text-muted-foreground">SKU: {project.sku_base}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {new Date(project.created_at).toLocaleDateString('es-CL')}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

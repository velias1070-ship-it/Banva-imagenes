import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { createServerSupabase } from '@/lib/supabase/server';
import type { Sku, Project } from '@/types/database';

export const dynamic = 'force-dynamic';

interface ProjectLink {
  project: Project;
}

export default async function SkuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: sku } = await supabase
    .from('skus')
    .select('*')
    .eq('id', id)
    .maybeSingle<Sku>();

  if (!sku) notFound();

  const { data: links } = await supabase
    .from('project_skus')
    .select('project:projects(*)')
    .eq('sku_id', id);

  const projects = ((links || []) as unknown as ProjectLink[])
    .map((l) => l.project)
    .filter(Boolean)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return (
    <div className="p-8">
      <Link
        href="/skus"
        className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al catálogo
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-2">
          {sku.product_family && (
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {sku.product_family}
            </span>
          )}
          {sku.status === 'archived' && (
            <Badge variant="outline" className="text-[10px]">
              archivado
            </Badge>
          )}
        </div>
        <h1 className="mt-1 text-2xl font-bold">{sku.name}</h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{sku.code}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          {sku.category && <span>{sku.category}</span>}
          <span>·</span>
          <span>
            {projects.length} tanda{projects.length !== 1 ? 's' : ''} vinculada
            {projects.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Biblioteca de imágenes
        </h2>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Próximamente: aquí se verán todas las imágenes aprobadas del SKU
            acumuladas a lo largo de las tandas, con su estado en MercadoLibre.
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Tandas (proyectos)
        </h2>
        {projects.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Este SKU no tiene tandas vinculadas aún.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}/results`}>
                <Card className="cursor-pointer transition-shadow hover:shadow-md">
                  <CardContent className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.created_at).toLocaleDateString('es-CL')} ·{' '}
                        {p.category}
                      </p>
                    </div>
                    <ExternalLink className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

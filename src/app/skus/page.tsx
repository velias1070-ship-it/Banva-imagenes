import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { FolderPlus, Package } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import type { Sku } from '@/types/database';
import { SkusFilter } from './skus-filter';

export const dynamic = 'force-dynamic';

interface SkuRow extends Sku {
  project_count: number;
}

export default async function SkusPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { q, status } = await searchParams;
  const supabase = await createServerSupabase();

  const query = supabase
    .from('skus')
    .select('*, project_skus(project_id)')
    .order('product_family', { ascending: true, nullsFirst: false })
    .order('code', { ascending: true });

  const { data: rawSkus } = await query;

  type RawSku = Sku & { project_skus: { project_id: string }[] | null };
  const skus: SkuRow[] = ((rawSkus || []) as RawSku[]).map((s) => ({
    ...s,
    project_count: s.project_skus?.length || 0,
  }));

  // Filter
  const search = (q || '').trim().toLowerCase();
  const statusFilter = (status || 'active') as 'active' | 'archived' | 'all';
  const filtered = skus.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (!search) return true;
    return (
      s.code.toLowerCase().includes(search) ||
      s.name.toLowerCase().includes(search) ||
      (s.product_family || '').toLowerCase().includes(search)
    );
  });

  // Group by product_family
  const groups = new Map<string, SkuRow[]>();
  for (const sku of filtered) {
    const key = sku.product_family || 'Otros';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sku);
  }
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === 'Otros') return 1;
    if (b[0] === 'Otros') return -1;
    return a[0].localeCompare(b[0]);
  });

  const totalActive = skus.filter((s) => s.status === 'active').length;
  const totalArchived = skus.filter((s) => s.status === 'archived').length;

  return (
    <div className="p-8">
      <div className="mb-8 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold">Catálogo de SKUs</h1>
          <p className="text-muted-foreground">
            {totalActive} activos{totalArchived > 0 ? ` · ${totalArchived} archivados` : ''} · {sortedGroups.length} familias
          </p>
        </div>
        <Link
          href="/projects"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <FolderPlus className="mr-1.5 h-4 w-4" />
          Ver proyectos (tandas)
        </Link>
      </div>

      <SkusFilter initialQuery={q || ''} initialStatus={statusFilter} />

      {sortedGroups.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <Package className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">
                {skus.length === 0 ? 'No hay SKUs aun.' : 'No hay SKUs que coincidan con el filtro.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {sortedGroups.map(([family, familySkus]) => (
            <section key={family}>
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {family}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {familySkus.length} SKU{familySkus.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {familySkus.map((sku) => (
                  <Link key={sku.id} href={`/skus/${sku.id}`}>
                    <Card className="cursor-pointer transition-shadow hover:shadow-md">
                      <CardContent className="pt-5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate font-semibold text-sm leading-tight">{sku.name}</h3>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                              {sku.code}
                            </p>
                          </div>
                          {sku.status === 'archived' && (
                            <Badge variant="outline" className="text-[10px]">
                              archivado
                            </Badge>
                          )}
                        </div>
                        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                          {sku.category && <span>{sku.category}</span>}
                          <span>·</span>
                          <span>
                            {sku.project_count} tanda{sku.project_count !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { headers } from 'next/headers';

interface Props {
  params: Promise<{ id: string }>;
}

interface CoverageCell {
  design: string;
  size: string;
  exact: number;
  design_only: number;
  size_only: number;
  generic: number;
  status: 'green' | 'yellow' | 'red';
}

interface CoverageResponse {
  project: { id: string; name: string; sku_base: string | null; category: string };
  designs: { slug: string; name: string }[];
  sizes: string[];
  heroes_total: number;
  variants_total: number;
  variants_with_size: number;
  variants_without_size: string[];
  cells: CoverageCell[];
}

export const dynamic = 'force-dynamic';

async function getCoverage(id: string): Promise<CoverageResponse | null> {
  const h = await headers();
  const host = h.get('host') || 'localhost:3000';
  const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
  const res = await fetch(`${proto}://${host}/api/projects/${id}/hero-coverage`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

const STATUS_STYLES: Record<CoverageCell['status'], string> = {
  green: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  yellow: 'bg-amber-100 text-amber-900 border-amber-300',
  red: 'bg-rose-100 text-rose-900 border-rose-300',
};

export default async function CoveragePage({ params }: Props) {
  const { id } = await params;
  const data = await getCoverage(id);

  if (!data) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">No se pudo cargar la cobertura.</p>
      </div>
    );
  }

  const { project, designs, sizes, cells, heroes_total, variants_total, variants_with_size, variants_without_size } =
    data;

  const cellMap = new Map<string, CoverageCell>();
  for (const c of cells) cellMap.set(`${c.design}|${c.size}`, c);

  return (
    <div className="p-8">
      <Link href={`/projects/${id}`} className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Volver al proyecto
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">{project.name} · Cobertura de heros</h1>
        <p className="text-muted-foreground">
          {project.category} {project.sku_base ? `· ${project.sku_base}` : ''}
        </p>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Heros en el proyecto</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold">{heroes_total}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Variantes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{variants_total}</div>
            <p className="text-xs text-muted-foreground">{variants_with_size} con tamano detectado</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Disenos x Tamanos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {designs.length} x {sizes.length}
            </div>
            <p className="text-xs text-muted-foreground">{designs.length * sizes.length} celdas</p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 flex gap-3 text-xs">
        <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300" variant="outline">
          Verde · hero con match exacto (diseno + tamano)
        </Badge>
        <Badge className="bg-amber-100 text-amber-900 border-amber-300" variant="outline">
          Amarillo · solo match parcial / generico
        </Badge>
        <Badge className="bg-rose-100 text-rose-900 border-rose-300" variant="outline">
          Rojo · sin hero aplicable
        </Badge>
      </div>

      <div className="overflow-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40">
              <th className="sticky left-0 bg-muted/40 px-3 py-2 text-left font-medium">Diseno</th>
              {sizes.map((s) => (
                <th key={s} className="px-3 py-2 text-left font-medium">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {designs.map((d) => (
              <tr key={d.slug} className="border-t">
                <td className="sticky left-0 bg-background px-3 py-2 font-medium">
                  {d.name}
                  <div className="text-xs text-muted-foreground">{d.slug}</div>
                </td>
                {sizes.map((s) => {
                  const cell = cellMap.get(`${d.slug}|${s}`);
                  if (!cell) return <td key={s} className="px-3 py-2 text-muted-foreground">—</td>;
                  return (
                    <td key={s} className="px-2 py-2">
                      <div className={`rounded border px-2 py-1 ${STATUS_STYLES[cell.status]}`}>
                        <div className="text-base font-semibold">
                          {cell.exact + cell.design_only + cell.size_only + cell.generic}
                        </div>
                        <div className="text-[10px] leading-tight">
                          {cell.exact}E · {cell.design_only}D · {cell.size_only}S · {cell.generic}G
                        </div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        E = exacto (diseno + tamano), D = solo diseno, S = solo tamano, G = generico (aplica a todos).
      </p>

      {variants_without_size.length > 0 && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="font-medium text-amber-900">
            {variants_without_size.length} SKU sin tamano detectable
          </div>
          <div className="mt-1 text-xs text-amber-800 break-all">{variants_without_size.join(', ')}</div>
        </div>
      )}
    </div>
  );
}

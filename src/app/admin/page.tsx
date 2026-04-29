import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminHomePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Admin</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Link href="/admin/costos">
          <Card className="hover:bg-gray-50 cursor-pointer h-full">
            <CardHeader><CardTitle>Costos &amp; Salud</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Gasto en vivo por proyecto y modelo, jobs colgados, salud del pipeline. Auto-refresh.
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/models">
          <Card className="hover:bg-gray-50 cursor-pointer h-full">
            <CardHeader><CardTitle>Models & Routing</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Edit <code>routing-rules.json</code> — primary/fallback chains per category, swatch overrides, cost caps.
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/benchmarks">
          <Card className="hover:bg-gray-50 cursor-pointer h-full">
            <CardHeader><CardTitle>Benchmarks</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Run a golden suite, browse historical runs, compare runs across models.
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/performance">
          <Card className="hover:bg-gray-50 cursor-pointer h-full">
            <CardHeader><CardTitle>Model Performance</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                model_performance MV — approval rates by (model, case_signature, attempt). Refresh on demand.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type WindowSummary = { jobs: number; usd: number; clp: number; approved: number };
type ProjectRow = { project_id: string; name: string; jobs: number; usd: number; clp: number; approved: number; stuck: number; flagged: number; error: number };
type ModelRow = { model: string; jobs: number; usd: number; approved: number; avg_per_job: number };
type StatusRow = { status: string; jobs: number; usd: number };
type Recent = {
  id: string; project: string; swatch: string | null; shot_type: string | null;
  status: string; attempt: number | null; cost_usd: number; model: string | null; updated_at: string;
};
type Health = {
  last_approved_at: string | null;
  last_generation_at: string | null;
  rate_limited_last_hour: number;
  approval_rate_24h: number | null;
};
type CostsPayload = {
  generated_at: string;
  summary: { today: WindowSummary; yesterday: WindowSummary; last_7d: WindowSummary; last_30d: WindowSummary };
  by_project: ProjectRow[];
  by_model: ModelRow[];
  by_status: StatusRow[];
  wasted: { jobs: number; usd: number; clp: number };
  health: Health;
  recent: Recent[];
};

const CLP = (n: number) => '$' + Math.round(n).toLocaleString('es-CL');
const USD = (n: number) => '$' + n.toFixed(n < 1 ? 4 : 2);

function statusBadge(s: string) {
  const map: Record<string, string> = {
    approved: 'bg-green-100 text-green-800',
    flagged: 'bg-amber-100 text-amber-800',
    qa_pending: 'bg-blue-100 text-blue-800',
    qa_processing: 'bg-blue-100 text-blue-800',
    qa_rate_limited: 'bg-orange-100 text-orange-800',
    error: 'bg-red-100 text-red-800',
    pending: 'bg-gray-100 text-gray-700',
    generating: 'bg-blue-100 text-blue-800',
  };
  return map[s] || 'bg-gray-100 text-gray-700';
}

function relativeTime(iso: string | null) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export default function CostsPage() {
  const [data, setData] = useState<CostsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch('/api/admin/costs', { cache: 'no-store' });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !data) {
    return <div className="p-6 text-sm text-muted-foreground">Cargando…</div>;
  }
  if (error && !data) {
    return <div className="p-6 text-sm text-red-700">Error: {error}</div>;
  }
  if (!data) return null;

  const { summary, by_project, by_model, by_status, wasted, health, recent } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Costos &amp; Salud</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gasto real por proyecto y modelo. Cap mensual lo controlas en Google AI Studio. Auto-refresh cada 30s.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          Última actualización: {relativeTime(data.generated_at)}
        </div>
      </div>

      {/* Time windows */}
      <div className="grid gap-4 md:grid-cols-4">
        <WindowCard title="Hoy" w={summary.today} />
        <WindowCard title="Ayer" w={summary.yesterday} />
        <WindowCard title="Últimos 7 días" w={summary.last_7d} />
        <WindowCard title="Últimos 30 días" w={summary.last_30d} />
      </div>

      {/* Health + Wasted */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Salud del pipeline</CardTitle></CardHeader>
          <CardContent>
            <ul className="text-sm space-y-2">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Última imagen aprobada</span>
                <span className="font-mono">{relativeTime(health.last_approved_at)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Última generación con costo</span>
                <span className="font-mono">{relativeTime(health.last_generation_at)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">429s en última hora</span>
                <span className={`font-mono ${health.rate_limited_last_hour > 0 ? 'text-orange-700 font-semibold' : ''}`}>
                  {health.rate_limited_last_hour}
                </span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">% aprobación últimas 24h</span>
                <span className="font-mono">
                  {health.approval_rate_24h == null ? '—' : (health.approval_rate_24h * 100).toFixed(0) + '%'}
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card className={wasted.jobs > 0 ? 'border-orange-300 bg-orange-50' : ''}>
          <CardHeader>
            <CardTitle>
              Costo &quot;perdido&quot; (jobs colgados)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{CLP(wasted.clp)}</div>
            <div className="text-sm text-muted-foreground mt-1">
              {wasted.jobs} jobs en qa_rate_limited / qa_pending / qa_processing — la API se cobró pero la imagen aún no quedó usable.
            </div>
            {wasted.jobs > 0 && (
              <div className="text-xs text-orange-800 mt-2">
                Si los abandonas, este monto se pierde. Si liberas la cuota o los apruebas manualmente, la inversión se recupera.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* By project */}
      <Card>
        <CardHeader><CardTitle>Por proyecto (últimos 30 días)</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 font-medium">Proyecto</th>
                  <th className="py-2 font-medium text-right">Jobs</th>
                  <th className="py-2 font-medium text-right">Aprobados</th>
                  <th className="py-2 font-medium text-right">Colgados</th>
                  <th className="py-2 font-medium text-right">Flag</th>
                  <th className="py-2 font-medium text-right">Error</th>
                  <th className="py-2 font-medium text-right">CLP</th>
                  <th className="py-2 font-medium text-right">USD</th>
                </tr>
              </thead>
              <tbody>
                {by_project.map(p => (
                  <tr key={p.project_id} className="border-b last:border-0">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right">{p.jobs}</td>
                    <td className="py-2 text-right text-green-700">{p.approved}</td>
                    <td className="py-2 text-right text-orange-700">{p.stuck}</td>
                    <td className="py-2 text-right text-amber-700">{p.flagged}</td>
                    <td className="py-2 text-right text-red-700">{p.error}</td>
                    <td className="py-2 text-right font-mono">{CLP(p.clp)}</td>
                    <td className="py-2 text-right font-mono text-muted-foreground">{USD(p.usd)}</td>
                  </tr>
                ))}
                {by_project.length === 0 && (
                  <tr><td colSpan={8} className="py-4 text-center text-muted-foreground">Sin datos</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* By model */}
      <Card>
        <CardHeader><CardTitle>Por modelo (últimos 30 días)</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 font-medium">Modelo</th>
                  <th className="py-2 font-medium text-right">Jobs</th>
                  <th className="py-2 font-medium text-right">Aprobados</th>
                  <th className="py-2 font-medium text-right">USD/job</th>
                  <th className="py-2 font-medium text-right">Total USD</th>
                </tr>
              </thead>
              <tbody>
                {by_model.map(m => (
                  <tr key={m.model} className="border-b last:border-0">
                    <td className="py-2 font-mono text-xs">{m.model}</td>
                    <td className="py-2 text-right">{m.jobs}</td>
                    <td className="py-2 text-right text-green-700">{m.approved}</td>
                    <td className="py-2 text-right font-mono">{USD(m.avg_per_job)}</td>
                    <td className="py-2 text-right font-mono">{USD(m.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* By status */}
      <Card>
        <CardHeader><CardTitle>Por estado (últimos 30 días)</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            {by_status.map(s => (
              <div key={s.status} className="flex items-center justify-between rounded border p-3 text-sm">
                <span className={`px-2 py-0.5 rounded text-xs font-mono ${statusBadge(s.status)}`}>{s.status}</span>
                <div className="text-right">
                  <div className="font-semibold">{s.jobs}</div>
                  <div className="text-xs text-muted-foreground font-mono">{USD(s.usd)}</div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent jobs */}
      <Card>
        <CardHeader><CardTitle>Últimos 40 jobs</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 font-medium">Hace</th>
                  <th className="py-2 font-medium">Proyecto</th>
                  <th className="py-2 font-medium">Swatch</th>
                  <th className="py-2 font-medium">Shot</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Modelo</th>
                  <th className="py-2 font-medium text-right">USD</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(j => (
                  <tr key={j.id} className="border-b last:border-0">
                    <td className="py-1.5 font-mono text-muted-foreground">{relativeTime(j.updated_at)}</td>
                    <td className="py-1.5">{j.project}</td>
                    <td className="py-1.5">{j.swatch || '—'}</td>
                    <td className="py-1.5 text-muted-foreground">{j.shot_type || '—'}</td>
                    <td className="py-1.5">
                      <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${statusBadge(j.status)}`}>{j.status}</span>
                    </td>
                    <td className="py-1.5 text-center">{j.attempt ?? '—'}</td>
                    <td className="py-1.5 font-mono text-[11px] text-muted-foreground">{j.model || '—'}</td>
                    <td className="py-1.5 text-right font-mono">{USD(j.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function WindowCard({ title, w }: { title: string; w: WindowSummary }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{CLP(w.clp)}</div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">{USD(w.usd)} USD</div>
        <div className="text-xs text-muted-foreground mt-2">
          {w.jobs} jobs · {w.approved} aprobados ({w.jobs > 0 ? Math.round(w.approved / w.jobs * 100) : 0}%)
        </div>
      </CardContent>
    </Card>
  );
}

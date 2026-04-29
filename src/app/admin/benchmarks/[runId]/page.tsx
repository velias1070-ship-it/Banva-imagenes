import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CompareForm } from '../CompareForm';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  run_id: string;
  case_id: string;
  model_id_tested: string;
  score_total: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  output_path: string | null;
  run_metadata: Record<string, unknown> | null;
  suite_name: string | null;
  dynamic_filter: string | null;
  compared_to_run_id: string | null;
  run_at: string;
}

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase
    .from('golden_runs')
    .select('id, run_id, case_id, model_id_tested, score_total, cost_usd, duration_ms, output_path, run_metadata, suite_name, dynamic_filter, compared_to_run_id, run_at')
    .eq('run_id', runId)
    .order('run_at', { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data || []) as Row[];
  if (rows.length === 0) notFound();

  const head = rows[0];
  const totalCost = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const okCount = rows.filter((r) => (r.score_total ?? 0) > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/benchmarks" className="text-sm text-blue-600 hover:underline">← All runs</Link>
        <h1 className="text-2xl font-bold mt-2">Run <code className="text-base">{runId}</code></h1>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader><CardTitle className="text-sm">Source</CardTitle></CardHeader><CardContent className="text-sm">
          {head.suite_name || head.dynamic_filter || 'jobs'}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Model</CardTitle></CardHeader><CardContent className="text-sm font-mono">{head.model_id_tested}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Outcome</CardTitle></CardHeader><CardContent className="text-sm">{okCount}/{rows.length} OK · ${totalCost.toFixed(3)}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">When</CardTitle></CardHeader><CardContent className="text-sm">{new Date(head.run_at).toLocaleString()}</CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Compare with another run</CardTitle></CardHeader>
        <CardContent>
          <CompareForm baseRunId={runId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Cases ({rows.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const meta = r.run_metadata || {};
                const note = meta.error ? String(meta.error) : meta.recommendation ? `recommendation: ${meta.recommendation}` : '';
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs font-mono">{r.case_id}</TableCell>
                    <TableCell className="text-xs text-right">{r.score_total !== null ? r.score_total.toFixed(2) : '—'}</TableCell>
                    <TableCell className="text-xs text-right font-mono">${(r.cost_usd ?? 0).toFixed(3)}</TableCell>
                    <TableCell className="text-xs text-right">{r.duration_ms ? `${r.duration_ms}ms` : '—'}</TableCell>
                    <TableCell className="text-xs font-mono break-all">{r.output_path || '—'}</TableCell>
                    <TableCell className="text-xs">{note}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

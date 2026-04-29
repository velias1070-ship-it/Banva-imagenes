import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

interface RunRow {
  run_id: string;
  suite_name: string | null;
  dynamic_filter: string | null;
  job_ids_input: string[] | null;
  model_id_tested: string;
  cost_usd: number | null;
  score_total: number | null;
  run_at: string;
  compared_to_run_id: string | null;
}

interface RunSummary {
  run_id: string;
  source: string;
  model_id: string;
  cases: number;
  ok: number;
  total_cost: number;
  run_at: string;
  is_comparison: boolean;
}

async function fetchRunSummaries(): Promise<RunSummary[]> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await supabase
    .from('golden_runs')
    .select('run_id, suite_name, dynamic_filter, job_ids_input, model_id_tested, cost_usd, score_total, run_at, compared_to_run_id')
    .order('run_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = (data || []) as RunRow[];

  const byRun = new Map<string, RunSummary>();
  for (const r of rows) {
    const key = r.run_id;
    const source = r.suite_name
      ? `suite: ${r.suite_name}`
      : r.dynamic_filter
        ? `filter: ${r.dynamic_filter}`
        : r.job_ids_input
          ? `${r.job_ids_input.length} jobs`
          : 'unknown';
    const cur = byRun.get(key) || {
      run_id: r.run_id,
      source,
      model_id: r.model_id_tested,
      cases: 0,
      ok: 0,
      total_cost: 0,
      run_at: r.run_at,
      is_comparison: !!r.compared_to_run_id,
    };
    cur.cases += 1;
    cur.ok += (r.score_total ?? 0) > 0 ? 1 : 0;
    cur.total_cost += Number(r.cost_usd ?? 0);
    if (r.run_at > cur.run_at) cur.run_at = r.run_at;
    byRun.set(key, cur);
  }
  return Array.from(byRun.values()).sort((a, b) => b.run_at.localeCompare(a.run_at));
}

export default async function BenchmarksPage() {
  const summaries = await fetchRunSummaries();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Benchmarks</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Historical golden runs. Each row is one CLI invocation grouped by run_id.
          </p>
        </div>
        <Link href="/admin/benchmarks/new"><Button>+ New benchmark</Button></Link>
      </div>

      <Card>
        <CardHeader><CardTitle>Recent runs ({summaries.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Cases</TableHead>
                <TableHead className="text-right">OK</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>run_id</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summaries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No runs yet. Trigger one from <code>npm run golden</code> or via the form.
                  </TableCell>
                </TableRow>
              )}
              {summaries.map((s) => (
                <TableRow key={s.run_id}>
                  <TableCell className="text-xs">{new Date(s.run_at).toLocaleString()}</TableCell>
                  <TableCell className="text-xs font-mono">
                    {s.source}
                    {s.is_comparison && <span className="ml-1 text-xs rounded bg-blue-100 text-blue-800 px-1">cmp</span>}
                  </TableCell>
                  <TableCell className="text-xs font-mono">{s.model_id}</TableCell>
                  <TableCell className="text-xs text-right">{s.cases}</TableCell>
                  <TableCell className="text-xs text-right">{s.ok}/{s.cases}</TableCell>
                  <TableCell className="text-xs text-right font-mono">${s.total_cost.toFixed(3)}</TableCell>
                  <TableCell className="text-xs">
                    <Link href={`/admin/benchmarks/${s.run_id}`} className="text-blue-600 hover:underline font-mono">
                      {s.run_id.slice(0, 8)}…
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

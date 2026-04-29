import { createClient } from '@supabase/supabase-js';
import { Card, CardContent } from '@/components/ui/card';
import { PerformanceTable, type PerfRow } from './PerformanceTable';

export const dynamic = 'force-dynamic';

export default async function PerformancePage() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase
    .from('model_performance')
    .select('model_id, case_signature, attempt, total_jobs, approved_count, flagged_count, error_count, approval_pct, avg_qa_score, avg_cost_usd, total_cost_usd, avg_duration_ms, cost_capped_count, first_seen, last_seen')
    .order('total_jobs', { ascending: false })
    .limit(1000);

  let rows: PerfRow[] = [];
  let queryError: string | null = null;
  if (error) queryError = error.message;
  else rows = (data || []) as PerfRow[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Model Performance</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Aggregated outcomes from <code>model_performance</code> materialized view. Refresh via the button — the daily cron also keeps it current.
        </p>
      </div>

      {queryError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 text-sm text-red-700">
            Could not read <code>model_performance</code>: {queryError}
          </CardContent>
        </Card>
      ) : (
        <PerformanceTable initialRows={rows} />
      )}
    </div>
  );
}

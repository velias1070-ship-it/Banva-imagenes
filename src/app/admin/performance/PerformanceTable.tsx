'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw } from 'lucide-react';

export interface PerfRow {
  model_id: string;
  case_signature: string;
  attempt: number;
  total_jobs: number;
  approved_count: number;
  flagged_count: number;
  error_count: number;
  approval_pct: number | string | null;
  avg_qa_score: number | string | null;
  avg_cost_usd: number | string | null;
  total_cost_usd: number | string | null;
  avg_duration_ms: number | string | null;
  cost_capped_count: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

type SortKey = keyof PerfRow;
type SortDir = 'asc' | 'desc';

function asNum(v: PerfRow[keyof PerfRow]): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function PerformanceTable({ initialRows }: { initialRows: PerfRow[] }) {
  const [rows] = useState<PerfRow[]>(initialRows);
  const [filterModel, setFilterModel] = useState('');
  const [filterSig, setFilterSig] = useState('');
  const [minAttempt, setMinAttempt] = useState('');
  const [maxAttempt, setMaxAttempt] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('total_jobs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return rows
      .filter((r) => {
        if (filterModel && !r.model_id.toLowerCase().includes(filterModel.toLowerCase())) return false;
        if (filterSig && !r.case_signature.toLowerCase().includes(filterSig.toLowerCase())) return false;
        if (minAttempt && r.attempt < parseInt(minAttempt)) return false;
        if (maxAttempt && r.attempt > parseInt(maxAttempt)) return false;
        return true;
      })
      .sort((a, b) => {
        const aV = a[sortKey];
        const bV = b[sortKey];
        if (aV === null && bV === null) return 0;
        if (aV === null) return 1;
        if (bV === null) return -1;
        const aN = asNum(aV);
        const bN = asNum(bV);
        if (aN !== null && bN !== null) return sortDir === 'asc' ? aN - bN : bN - aN;
        return sortDir === 'asc' ? String(aV).localeCompare(String(bV)) : String(bV).localeCompare(String(aV));
      });
  }, [rows, filterModel, filterSig, minAttempt, maxAttempt, sortKey, sortDir]);

  function flipSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function arrow(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await fetch('/api/admin/performance/refresh', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setRefreshMsg(`refreshed at ${new Date().toLocaleTimeString()} — reloading…`);
      window.location.reload();
    } catch (err) {
      setRefreshMsg(`error: ${err instanceof Error ? err.message : String(err)}`);
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="grid gap-3 md:grid-cols-4 flex-1">
          <div>
            <Label className="text-xs">Model contains</Label>
            <Input value={filterModel} onChange={(e) => setFilterModel(e.target.value)} placeholder="gemini" />
          </div>
          <div>
            <Label className="text-xs">Signature contains</Label>
            <Input value={filterSig} onChange={(e) => setFilterSig(e.target.value)} placeholder="alfombras" />
          </div>
          <div>
            <Label className="text-xs">Attempt min</Label>
            <Input value={minAttempt} onChange={(e) => setMinAttempt(e.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs">Attempt max</Label>
            <Input value={maxAttempt} onChange={(e) => setMaxAttempt(e.target.value)} placeholder="3" />
          </div>
        </div>
        <Button onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </Button>
      </div>
      {refreshMsg && <p className="text-xs text-muted-foreground">{refreshMsg}</p>}

      <Card>
        <CardHeader><CardTitle>Rows ({filtered.length} / {rows.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer" onClick={() => flipSort('model_id')}>Model{arrow('model_id')}</TableHead>
                  <TableHead className="cursor-pointer" onClick={() => flipSort('case_signature')}>Case signature{arrow('case_signature')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('attempt')}>Attempt{arrow('attempt')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('total_jobs')}>Jobs{arrow('total_jobs')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('approved_count')}>Apprv{arrow('approved_count')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('approval_pct')}>%{arrow('approval_pct')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('avg_qa_score')}>Avg QA{arrow('avg_qa_score')}</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => flipSort('avg_cost_usd')}>Avg cost{arrow('avg_cost_usd')}</TableHead>
                  <TableHead className="cursor-pointer" onClick={() => flipSort('last_seen')}>Last seen{arrow('last_seen')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No rows match.
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((r, i) => {
                  const pct = asNum(r.approval_pct);
                  const qa = asNum(r.avg_qa_score);
                  const cost = asNum(r.avg_cost_usd);
                  return (
                    <TableRow key={`${r.model_id}-${r.case_signature}-${r.attempt}-${i}`}>
                      <TableCell className="text-xs font-mono">{r.model_id}</TableCell>
                      <TableCell className="text-xs font-mono">{r.case_signature}</TableCell>
                      <TableCell className="text-xs text-right">{r.attempt}</TableCell>
                      <TableCell className="text-xs text-right">{r.total_jobs}</TableCell>
                      <TableCell className="text-xs text-right">{r.approved_count}</TableCell>
                      <TableCell className="text-xs text-right">{pct !== null ? `${pct.toFixed(0)}%` : '—'}</TableCell>
                      <TableCell className="text-xs text-right">{qa !== null ? qa.toFixed(2) : '—'}</TableCell>
                      <TableCell className="text-xs text-right font-mono">{cost !== null ? `$${cost.toFixed(3)}` : '—'}</TableCell>
                      <TableCell className="text-xs">{r.last_seen ? new Date(r.last_seen).toLocaleDateString() : '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

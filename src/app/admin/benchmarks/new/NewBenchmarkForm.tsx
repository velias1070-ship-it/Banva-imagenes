'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface SuiteOption { name: string; caseCount: number }
interface ModelOption { id: string; cost: number }
interface Props { suites: SuiteOption[]; models: ModelOption[] }

export function NewBenchmarkForm({ suites, models }: Props) {
  const router = useRouter();
  const [suite, setSuite] = useState('');
  const [model, setModel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSuite = suites.find((s) => s.name === suite);
  const selectedModel = models.find((m) => m.id === model);
  const projectedCost = selectedSuite && selectedModel ? selectedSuite.caseCount * selectedModel.cost : null;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/benchmarks/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suite, model }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      router.push(`/admin/benchmarks/${body.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>Suite</Label>
          <Select value={suite} onValueChange={setSuite}>
            <SelectTrigger><SelectValue placeholder="Pick a YAML suite" /></SelectTrigger>
            <SelectContent>
              {suites.map((s) => (
                <SelectItem key={s.name} value={s.name}>{s.name} ({s.caseCount} cases)</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger><SelectValue placeholder="Pick a model" /></SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.id} (${m.cost.toFixed(3)}/img)</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {projectedCost !== null && (
          <div className="rounded border p-3 text-sm bg-gray-50">
            <p>Projected cost: <code className="font-mono">${projectedCost.toFixed(2)}</code></p>
            <p className="text-xs text-muted-foreground mt-1">
              {selectedSuite!.caseCount} cases × ${selectedModel!.cost.toFixed(3)}/img
            </p>
          </div>
        )}

        <Button onClick={submit} disabled={!suite || !model || submitting} className="w-full">
          {submitting ? 'Starting…' : 'Run'}
        </Button>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}

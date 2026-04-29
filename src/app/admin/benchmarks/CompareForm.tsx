'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface Props {
  baseRunId: string;
}

export function CompareForm({ baseRunId }: Props) {
  const [against, setAgainst] = useState('');
  const [persist, setPersist] = useState(false);
  const [loading, setLoading] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setMarkdown(null);
    try {
      const res = await fetch('/api/admin/benchmarks/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base: baseRunId, against, persist }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setMarkdown(body.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs">against run_id</Label>
          <Input
            placeholder="UUID of the other run"
            value={against}
            onChange={(e) => setAgainst(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id="persist" checked={persist} onCheckedChange={(v) => setPersist(!!v)} />
          <Label htmlFor="persist" className="text-xs">persist</Label>
        </div>
        <Button onClick={run} disabled={loading || !against}>
          {loading ? 'Running…' : 'Compare'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {markdown && (
        <pre className="bg-gray-900 text-gray-100 p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
          {markdown}
        </pre>
      )}
    </div>
  );
}

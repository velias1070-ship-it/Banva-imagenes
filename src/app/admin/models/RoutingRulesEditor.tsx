'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RoutingRules } from '@/lib/models/routing-rules.schema';

interface Props {
  initialRules: RoutingRules;
  modelIds: string[];
}

export function RoutingRulesEditor({ initialRules, modelIds }: Props) {
  const [json, setJson] = useState(() => JSON.stringify(initialRules, null, 2));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  let parsed: RoutingRules | null = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: json,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setFeedback({ type: 'ok', msg: `Committed: ${body.commitSha?.slice(0, 8) || 'ok'}. Vercel will redeploy.` });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Routing summary</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Default chain</p>
              <code className="text-sm">{parsed?.default_chain.join(' → ')}</code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-2">Categories</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead>Cost cap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed && Object.entries(parsed.categories).map(([cat, rule]) => {
                    const chain = (rule.attempts ?? parsed!.default_chain).join(' → ');
                    const cap = parsed!.max_cost_per_job_usd[cat] ?? parsed!.max_cost_per_job_usd.default;
                    return (
                      <TableRow key={cat}>
                        <TableCell className="font-mono text-xs">{cat}</TableCell>
                        <TableCell className="font-mono text-xs">{chain}</TableCell>
                        <TableCell className="font-mono text-xs">${cap.toFixed(2)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Available models</p>
              <p className="text-sm font-mono">{modelIds.join(', ')}</p>
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Edit JSON</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={28}
              className="font-mono text-xs"
            />
            {parseError && <p className="text-xs text-red-600">JSON parse error: {parseError}</p>}
            <div className="flex items-center justify-between">
              <Button onClick={save} disabled={saving || !!parseError}>
                {saving ? 'Saving…' : 'Validate & save'}
              </Button>
              {feedback && (
                <p className={`text-xs ${feedback.type === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
                  {feedback.msg}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

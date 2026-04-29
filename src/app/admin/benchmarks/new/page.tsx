import fs from 'fs';
import path from 'path';
import { MODEL_REGISTRY } from '@/lib/models/registry';
import { NewBenchmarkForm } from './NewBenchmarkForm';

export const dynamic = 'force-dynamic';

interface SuiteEntry {
  name: string;
  caseCount: number;
}

function listSuites(): SuiteEntry[] {
  const dir = path.join(process.cwd(), 'benchmarks', 'suites');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const matches = raw.match(/^- id:/gm);
      return { name: f.replace(/\.ya?ml$/, ''), caseCount: matches?.length ?? 0 };
    });
}

export default function NewBenchmarkPage() {
  const suites = listSuites();
  const models = Object.entries(MODEL_REGISTRY).map(([id, e]) => ({
    id,
    cost: e.costPerImageUsd,
  }));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">New benchmark</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run a YAML suite against a model. The run persists row-by-row to <code>golden_runs</code> so a timeout doesn&apos;t lose results.
        </p>
      </div>
      <NewBenchmarkForm suites={suites} models={models} />
    </div>
  );
}

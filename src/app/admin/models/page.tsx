import fs from 'fs';
import path from 'path';
import { RoutingRulesSchema, type RoutingRules } from '@/lib/models/routing-rules.schema';
import { MODEL_REGISTRY } from '@/lib/models/registry';
import { RoutingRulesEditor } from './RoutingRulesEditor';

export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const filePath = path.join(process.cwd(), 'config', 'routing-rules.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  // Strip $schema_note before validation (it's not part of the schema)
  const { $schema_note, ...payload } = parsed;
  const rules = RoutingRulesSchema.parse(payload) as RoutingRules;

  const modelIds = Object.keys(MODEL_REGISTRY);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Models & Routing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Edit <code>config/routing-rules.json</code>. Save commits the file via GitHub API and triggers a Vercel redeploy.
        </p>
      </div>
      <RoutingRulesEditor initialRules={rules} modelIds={modelIds} />
    </div>
  );
}

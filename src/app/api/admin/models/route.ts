/**
 * PUT /api/admin/models
 * Validates the posted JSON body against RoutingRulesSchema, then commits
 * config/routing-rules.json to the GitHub repo. Vercel auto-deploys on
 * push to main, so a successful PUT triggers a redeploy.
 *
 * Required env: GITHUB_TOKEN (repo:contents write), GITHUB_REPO ("owner/name").
 * Auth: requireAdmin() — Supabase session + ADMIN_EMAILS.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RoutingRulesSchema } from '@/lib/models/routing-rules.schema';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function PUT(req: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    if (err instanceof AdminAuthError) return NextResponse.json({ error: err.reason }, { status: 401 });
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parse = RoutingRulesSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: 'validation', issues: z.treeifyError(parse.error) }, { status: 400 });
  }

  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    return NextResponse.json(
      { error: 'GITHUB_REPO and GITHUB_TOKEN env vars required to commit changes' },
      { status: 500 },
    );
  }
  const branch = process.env.GITHUB_BRANCH || 'main';
  const filePath = 'config/routing-rules.json';

  // Fetch current file SHA (needed for update)
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!getRes.ok) {
    return NextResponse.json({ error: `github get failed: HTTP ${getRes.status}` }, { status: 502 });
  }
  const cur = await getRes.json();

  // Preserve $schema_note hint at top of file if present in original
  const out = { $schema_note: 'Validated at runtime by src/lib/models/routing-rules.schema.ts. Model ids must exist in MODEL_REGISTRY. Order in \'attempts\' arrays is the chain order: index 0 = attempt 0.', ...parse.data };
  const newContent = JSON.stringify(out, null, 2) + '\n';
  const b64 = Buffer.from(newContent, 'utf-8').toString('base64');

  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `chore(routing-rules): update via /admin/models (${admin.email})`,
      content: b64,
      sha: cur.sha,
      branch,
    }),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text();
    return NextResponse.json({ error: `github put failed: HTTP ${putRes.status}`, detail: errBody }, { status: 502 });
  }
  const putBody = await putRes.json();
  return NextResponse.json({ ok: true, commitSha: putBody.commit?.sha, htmlUrl: putBody.commit?.html_url });
}

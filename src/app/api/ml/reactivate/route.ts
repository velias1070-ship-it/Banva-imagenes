import { NextRequest, NextResponse } from 'next/server';
import { mlPut } from '@/lib/ml';

export const maxDuration = 60;

interface ReactivateRequest {
  item_ids: string[];
}

/**
 * POST /api/ml/reactivate
 * Body: { item_ids: string[] }
 *
 * Flips each listing's status from "paused" back to "active" via
 * PUT /items/{id} with { status: "active" }. Used after a bulk picture
 * backfill when ML had paused listings for missing/broken images.
 *
 * Returns per-item results so the caller can retry the failures.
 */
export async function POST(request: NextRequest) {
  const body: ReactivateRequest = await request.json();
  const { item_ids } = body;

  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return NextResponse.json({ error: 'item_ids is required' }, { status: 400 });
  }

  const results: Array<{
    item_id: string;
    success: boolean;
    new_status?: string;
    error?: string;
  }> = [];

  for (const itemId of item_ids) {
    try {
      const res = (await mlPut(`/items/${itemId}`, { status: 'active' })) as {
        status?: string;
      };
      results.push({ item_id: itemId, success: true, new_status: res?.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ item_id: itemId, success: false, error: msg.substring(0, 300) });
    }
  }

  const success = results.filter((r) => r.success).length;
  const failure = results.length - success;

  return NextResponse.json({ results, summary: { success, failure } });
}

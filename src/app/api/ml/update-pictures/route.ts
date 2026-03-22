import { NextRequest, NextResponse } from 'next/server';
import { mlPut } from '@/lib/ml';

export const maxDuration = 30;

interface UpdateRequest {
  item_id: string;
  pictures: ({ id: string } | { source: string })[];
}

/**
 * POST /api/ml/update-pictures
 *
 * Updates pictures on a ML listing with the exact order provided.
 * Accepts mix of:
 *   { id: "MLC123..." }  — keep existing picture
 *   { source: "https://..." }  — add new picture from URL
 */
export async function POST(request: NextRequest) {
  const body: UpdateRequest = await request.json();
  const { item_id, pictures } = body;

  if (!item_id) {
    return NextResponse.json({ error: 'item_id is required' }, { status: 400 });
  }

  if (!pictures?.length) {
    return NextResponse.json({ error: 'pictures array is required' }, { status: 400 });
  }

  try {
    const result = await mlPut(`/items/${item_id}`, { pictures });
    return NextResponse.json({ item_id, success: true, pictures_count: pictures.length, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ item_id, success: false, error: message }, { status: 500 });
  }
}

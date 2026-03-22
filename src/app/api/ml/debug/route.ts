import { NextRequest, NextResponse } from 'next/server';
import { mlGet } from '@/lib/ml';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path');

  if (!path) {
    return NextResponse.json(
      { error: 'Missing ?path= parameter. Example: /api/ml/debug?path=/items/MLC123' },
      { status: 400 }
    );
  }

  try {
    const response = await mlGet(path);
    return NextResponse.json({ path, response });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ path, error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;

  let body: { swatch_id?: string; mime_type?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const swatchId = body.swatch_id;
  const mimeType = body.mime_type;

  if (typeof swatchId !== 'string' || !swatchId) {
    return NextResponse.json({ error: 'swatch_id is required' }, { status: 400 });
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME.has(mimeType)) {
    return NextResponse.json({ error: `Unsupported mime_type ${mimeType ?? ''}` }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: swatch } = await supabase
    .from('swatches')
    .select('id, name, project_id')
    .eq('id', swatchId)
    .single();
  if (!swatch || swatch.project_id !== projectId) {
    return NextResponse.json({ error: 'Swatch not found in project' }, { status: 404 });
  }

  const jobId = crypto.randomUUID();
  const storagePath = `projects/${projectId}/generated/${jobId}.${extFromMime(mimeType)}`;

  const { data: signed, error: signErr } = await supabase.storage
    .from('images')
    .createSignedUploadUrl(storagePath);

  if (signErr || !signed) {
    return NextResponse.json(
      { error: `Failed to create signed URL: ${signErr?.message ?? 'unknown'}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    job_id: jobId,
    storage_path: storagePath,
    signed_url: signed.signedUrl,
    token: signed.token,
    swatch_name: swatch.name,
  });
}

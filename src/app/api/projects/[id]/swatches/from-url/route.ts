import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/projects/{id}/swatches/from-url
 * Body: { url: "https://...", name?: "Campine" }
 *
 * Downloads the image from the URL and creates a swatch.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json();
  const url = (body.url || '').trim();
  const name = (body.name || '').trim();

  if (!url) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    // Download image from URL
    const imgRes = await fetch(url, {
      headers: { 'Accept': 'image/*' },
    });

    if (!imgRes.ok) {
      return NextResponse.json({ error: `Failed to download: HTTP ${imgRes.status}` }, { status: 400 });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    if (imageBuffer.length < 1000) {
      return NextResponse.json({ error: 'Downloaded file too small — may not be a valid image' }, { status: 400 });
    }

    // Determine extension from content type or URL
    let ext = 'jpg';
    if (contentType.includes('png')) ext = 'png';
    else if (contentType.includes('webp')) ext = 'webp';
    else if (url.match(/\.(png|jpg|jpeg|webp)/i)) {
      const match = url.match(/\.(png|jpg|jpeg|webp)/i);
      if (match) ext = match[1].toLowerCase();
    }

    // Derive name from URL if not provided
    let swatchName = name;
    if (!swatchName) {
      // Try to extract filename from URL
      const urlPath = new URL(url).pathname;
      const fileName = urlPath.split('/').pop() || '';
      swatchName = fileName
        .replace(/\.[^.]+$/, '')  // remove extension
        .replace(/[-_]/g, ' ')   // dashes/underscores to spaces
        .replace(/\s+/g, ' ')    // collapse spaces
        .trim();
      if (!swatchName || swatchName.length < 2) {
        swatchName = 'Swatch desde URL';
      }
    }

    // Upload to Supabase Storage
    const storageName = `${crypto.randomUUID()}.${ext}`;
    const storagePath = `projects/${projectId}/swatches/${storageName}`;

    const { error: uploadError } = await supabase.storage
      .from('images')
      .upload(storagePath, imageBuffer, {
        contentType: contentType.startsWith('image/') ? contentType : `image/${ext}`,
        upsert: true,
      });

    if (uploadError) {
      return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    // Get next display_order
    const { data: lastSwatch } = await supabase
      .from('swatches')
      .select('display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: false })
      .limit(1);

    const nextOrder = (lastSwatch?.[0]?.display_order ?? -1) + 1;

    // Create swatch record
    const { data: swatch, error: insertError } = await supabase
      .from('swatches')
      .insert({
        project_id: projectId,
        name: swatchName,
        storage_path: storagePath,
        display_order: nextOrder,
        file_size_kb: Math.round(imageBuffer.length / 1024),
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json({ error: `DB insert failed: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ swatch, source_url: url }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface MlItemResponse {
  id: string;
  title: string;
  pictures: { id: string; secure_url: string; size: string }[];
}

/**
 * POST /api/projects/{id}/import-heroes-from-ml
 * Body: { item_id: "MLC123456789" }
 *
 * Downloads ALL pictures from an ML listing and creates them as hero_shots
 * in the project. Returns the created hero IDs for use in batch generation.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const body = await request.json();
  const { item_id } = body;

  if (!item_id) {
    return NextResponse.json({ error: 'item_id is required' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Verify project exists
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Fetch item from ML
  let item: MlItemResponse;
  try {
    item = await mlGet<MlItemResponse>(
      `/items/${item_id}?attributes=id,title,pictures`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      error: `Error fetching ML item ${item_id}: ${message}`,
    }, { status: 502 });
  }

  if (!item.pictures?.length) {
    return NextResponse.json({
      error: `Item ${item_id} has no pictures`,
    }, { status: 400 });
  }

  // Get current max display_order for heroes in this project
  const { data: lastHero } = await supabase
    .from('hero_shots')
    .select('display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: false })
    .limit(1);

  let nextOrder = (lastHero?.[0]?.display_order ?? -1) + 1;

  // Download each picture and create hero_shots
  const heroIds: string[] = [];
  const errors: { pic_id: string; error: string }[] = [];

  for (const pic of item.pictures) {
    try {
      // Use -F suffix for full quality (1200x1200)
      const imageUrl = pic.secure_url.replace(/-O\.(\w+)$/, '-F.$1');

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        errors.push({ pic_id: pic.id, error: `Download failed: ${imgRes.status}` });
        continue;
      }

      const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
      const ext = imageUrl.includes('.webp') ? 'webp' : 'jpg';
      const heroId = crypto.randomUUID();
      const storagePath = `projects/${projectId}/heroes/${heroId}.${ext}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('images')
        .upload(storagePath, imageBuffer, {
          contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg',
          upsert: true,
        });

      if (uploadError) {
        errors.push({ pic_id: pic.id, error: `Upload failed: ${uploadError.message}` });
        continue;
      }

      // Create hero_shot record
      // Shot type is unknown at this point, will be auto-detected during generation
      const filename = `${item_id}_${pic.id}.${ext}`;
      const { data: hero, error: insertError } = await supabase
        .from('hero_shots')
        .insert({
          id: heroId,
          project_id: projectId,
          filename,
          shot_type: 'lifestyle', // Default, will be auto-detected
          storage_path: storagePath,
          display_order: nextOrder++,
          file_size_kb: Math.round(imageBuffer.length / 1024),
        })
        .select('id')
        .single();

      if (insertError) {
        errors.push({ pic_id: pic.id, error: `DB insert failed: ${insertError.message}` });
        continue;
      }

      heroIds.push(hero.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pic_id: pic.id, error: message });
    }
  }

  return NextResponse.json({
    item_id,
    title: item.title,
    hero_ids: heroIds,
    total_pictures: item.pictures.length,
    imported: heroIds.length,
    errors: errors.length > 0 ? errors : undefined,
  }, { status: heroIds.length > 0 ? 201 : 500 });
}

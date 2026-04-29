import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { analyzeSwatchPattern } from '@/lib/swatch-planner';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: swatches, error } = await supabase
    .from('swatches')
    .select('*')
    .eq('project_id', id)
    .order('display_order', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(swatches);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const formData = await request.formData();
  const file = formData.get('file') as File;
  const name = (formData.get('name') as string) || file?.name?.replace(/\.[^.]+$/, '') || 'Sin nombre';
  const skuSuffix = formData.get('sku_suffix') as string | null;
  const colorDescription = formData.get('color_description') as string | null;

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  const fileExt = file.name.split('.').pop();
  const fileName = `${crypto.randomUUID()}.${fileExt}`;
  const storagePath = `projects/${id}/swatches/${fileName}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Get current max display_order
  const { data: existing } = await supabase
    .from('swatches')
    .select('display_order')
    .eq('project_id', id)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  const { data: swatch, error: insertError } = await supabase
    .from('swatches')
    .insert({
      project_id: id,
      name,
      sku_suffix: skuSuffix || null,
      color_description: colorDescription || null,
      storage_path: storagePath,
      display_order: nextOrder,
      file_size_kb: Math.round(file.size / 1024),
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Pre-warm the swatch pattern description in the background. The first job
  // that uses this swatch would otherwise pay ~7-9s + $0.002 for the analysis.
  // Doing it now means cache is hot by the time the user clicks "Generate".
  // Skip if a long color_description was supplied at upload (already warm).
  const swatchId = swatch.id as string;
  const skipWarm = !!(colorDescription && colorDescription.length > 100);
  if (!skipWarm) {
    after(async () => {
      try {
        const description = await analyzeSwatchPattern(
          buffer.toString('base64'),
          file.type || 'image/png',
          name,
        );
        if (description) {
          const admin = createAdminClient();
          // Re-read in case another writer (or a job that already ran) has
          // populated a long description in the meantime — only overwrite
          // when the column is still null or a short label like "Crema".
          const { data: current } = await admin
            .from('swatches')
            .select('color_description')
            .eq('id', swatchId)
            .single();
          const existing = current?.color_description as string | null;
          if (!existing || existing.length <= 100) {
            await admin
              .from('swatches')
              .update({ color_description: description })
              .eq('id', swatchId);
          }
        }
      } catch (err) {
        console.error(`[swatches] Pre-warm analyzeSwatchPattern failed for ${swatchId}:`, err);
      }
    });
  }

  return NextResponse.json(swatch, { status: 201 });
}

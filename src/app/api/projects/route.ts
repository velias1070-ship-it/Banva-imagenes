import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';
import { mlGet } from '@/lib/ml';

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export async function GET() {
  const supabase = await createServerSupabase();

  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(projects);
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { name, category, sku_base, description, variantes } = body;

  if (!name || !category) {
    return NextResponse.json(
      { error: 'name and category are required' },
      { status: 400 }
    );
  }

  const slug = slugify(name);

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      name,
      slug,
      category,
      sku_base: sku_base || null,
      description: description || null,
      status: 'draft',
      metadata: variantes ? { variantes } : {},
    })
    .select()
    .single();

  if (error) {
    console.error('[POST /api/projects] project insert error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If variantes came from the catalog, create swatch placeholders
  if (variantes && Array.isArray(variantes) && project) {
    const swatchRows = variantes.map((v: { sku: string; color: string; color_slug: string }, i: number) => ({
      project_id: project.id,
      name: v.color,
      sku_suffix: v.sku,
      color_description: v.color,
      storage_path: '',
      display_order: i,
    }));

    const { error: swatchError } = await supabase.from('swatches').insert(swatchRows);
    if (swatchError) {
      console.error('[POST /api/projects] swatch insert error:', swatchError);
    }

    // Ensure all SKUs exist in ml_items_map — search ML for missing ones
    try {
      const inventoryDb = getInventorySupabase();
      const skus = variantes.map((v: { sku: string }) => v.sku).filter(Boolean);

      if (skus.length > 0) {
        const { data: existing } = await inventoryDb
          .from('ml_items_map')
          .select('sku_venta')
          .in('sku_venta', skus)
          .eq('activo', true);

        const existingSkus = new Set((existing || []).map((r) => r.sku_venta));
        const missingSkus = skus.filter((s: string) => !existingSkus.has(s));

        if (missingSkus.length > 0) {
          console.log(`[POST /api/projects] ${missingSkus.length} SKUs missing from ml_items_map, searching ML...`);

          const sellerId = '1953806321';
          const newItems: { sku: string; item_id: string; titulo: string; activo: boolean; sku_venta: string }[] = [];

          for (const sku of missingSkus) {
            const result = await mlGet<{ results: string[] }>(
              `/users/${sellerId}/items/search?seller_sku=${sku}&limit=1`
            );
            if (result?.results?.[0]) {
              const itemId = result.results[0];
              const itemData = await mlGet<{ id: string; title: string }>(
                `/items/${itemId}?attributes=id,title`
              );
              newItems.push({
                sku: sku,
                sku_venta: sku,
                item_id: itemId,
                titulo: itemData?.title || '',
                activo: true,
              });
            }
          }

          if (newItems.length > 0) {
            await inventoryDb.from('ml_items_map').upsert(newItems, { onConflict: 'sku_venta,item_id' });
            console.log(`[POST /api/projects] Inserted ${newItems.length} items into ml_items_map`);
          }
        }
      }
    } catch (err) {
      console.error('[POST /api/projects] ml_items_map sync error:', err);
      // Non-blocking — project still created successfully
    }
  }

  return NextResponse.json(project, { status: 201 });
}

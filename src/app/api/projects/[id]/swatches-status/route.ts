import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

/**
 * GET /api/projects/{id}/swatches-status
 *
 * Returns ML status and stock for each swatch's SKU.
 * Response: { [swatchId]: { status, available_quantity, item_id } }
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();

  // Get swatches
  const { data: swatches } = await supabase
    .from('swatches')
    .select('id, sku_suffix')
    .eq('project_id', projectId);

  if (!swatches?.length) {
    return NextResponse.json({});
  }

  // Get item_ids from ml_items_map
  const skus = swatches.map((s) => s.sku_suffix).filter(Boolean) as string[];
  const { data: mlItems } = await inventoryDb
    .from('ml_items_map')
    .select('sku_venta, item_id')
    .in('sku_venta', skus.length > 0 ? skus : ['__none__'])
    .eq('activo', true)
    .is('variation_id', null);

  const skuToItemId = new Map((mlItems || []).map((m) => [m.sku_venta, m.item_id]));

  // Fetch status + stock from ML in batches of 20 (multi-get)
  const result: Record<string, { status: string; available_quantity: number; item_id: string }> = {};
  const itemIds = [...new Set(Array.from(skuToItemId.values()))];

  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    const multiIds = batch.join(',');

    const items = await mlGet<Array<{ code: number; body: { id: string; status: string; available_quantity: number } }>>(
      `/items?ids=${multiIds}&attributes=id,status,available_quantity`
    );

    if (items) {
      const itemMap = new Map<string, { status: string; available_quantity: number }>();
      for (const item of items) {
        if (item.body) {
          itemMap.set(item.body.id, {
            status: item.body.status,
            available_quantity: item.body.available_quantity,
          });
        }
      }

      // Map back to swatches
      for (const swatch of swatches) {
        if (!swatch.sku_suffix) continue;
        const itemId = skuToItemId.get(swatch.sku_suffix);
        if (!itemId) continue;
        const info = itemMap.get(itemId);
        if (info) {
          result[swatch.id] = {
            ...info,
            item_id: itemId,
          };
        }
      }
    }
  }

  return NextResponse.json(result);
}

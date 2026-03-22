import { NextResponse } from 'next/server';
import { mlGet, getSellerItems } from '@/lib/ml-client';

export const maxDuration = 60;

interface HealthAction {
  id: string;
  status: 'PENDING' | 'COMPLETED' | 'NOT_APPLICABLE';
  mandatory: boolean;
  metadata?: Record<string, unknown>;
}

interface ItemHealth {
  item_id: string;
  health: number | null;
  actions: HealthAction[];
}

interface ItemInfo {
  id: string;
  title: string;
  status: string;
  thumbnail: string;
  permalink: string;
  price: number;
  available_quantity: number;
  listing_type_id: string;
}

interface PerformanceItem {
  item_id: string;
  title: string;
  status: string;
  thumbnail: string;
  permalink: string;
  price: number;
  available_quantity: number;
  listing_type_id: string;
  health: number | null;
  pending_actions: Array<{
    id: string;
    mandatory: boolean;
    metadata?: Record<string, unknown>;
  }>;
  priority: number;
}

export async function GET() {
  try {
    // 1. Get all seller items
    const itemIds = await getSellerItems();
    if (!itemIds.length) {
      return NextResponse.json({ error: 'No items found or ML token invalid' }, { status: 400 });
    }

    // 2. Fetch item details + health in parallel batches of 20
    const results: PerformanceItem[] = [];
    const batchSize = 20;

    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);

      // Fetch item info in bulk (ML supports multi-get)
      const multiIds = batch.join(',');
      const itemsInfo = await mlGet<Array<{ code: number; body: ItemInfo }>>(
        `/items?ids=${multiIds}&attributes=id,title,status,thumbnail,permalink,price,available_quantity,listing_type_id`
      );

      // Fetch health for each item in parallel
      const healthPromises = batch.map((id) =>
        mlGet<ItemHealth>(`/items/${id}/health`)
          .catch(() => null)
      );
      const healthResults = await Promise.all(healthPromises);

      for (let j = 0; j < batch.length; j++) {
        const itemInfo = itemsInfo?.find((r) => r.body?.id === batch[j])?.body;
        const health = healthResults[j];

        if (!itemInfo) continue;

        const pendingActions = (health?.actions || [])
          .filter((a) => a.status === 'PENDING')
          .map((a) => ({
            id: a.id,
            mandatory: a.mandatory,
            metadata: a.metadata,
          }));

        // Priority score: more pending mandatory actions = higher priority
        const mandatoryCount = pendingActions.filter((a) => a.mandatory).length;
        const optionalCount = pendingActions.length - mandatoryCount;
        const priority = mandatoryCount * 10 + optionalCount;

        results.push({
          item_id: itemInfo.id,
          title: itemInfo.title,
          status: itemInfo.status,
          thumbnail: itemInfo.thumbnail,
          permalink: itemInfo.permalink,
          price: itemInfo.price,
          available_quantity: itemInfo.available_quantity,
          listing_type_id: itemInfo.listing_type_id,
          health: health?.health ?? null,
          pending_actions: pendingActions,
          priority,
        });
      }
    }

    // 3. Sort by priority (highest first), then by health (lowest first)
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return (a.health ?? 0) - (b.health ?? 0);
    });

    return NextResponse.json({
      total: results.length,
      with_pending: results.filter((r) => r.pending_actions.length > 0).length,
      items: results,
    });
  } catch (err) {
    console.error('[performance] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

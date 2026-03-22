import { NextRequest, NextResponse } from 'next/server';
import { mlPut, mlUploadImageFromUrl } from '@/lib/ml';

export const maxDuration = 60;

interface PictureEntry {
  id?: string;
  source?: string;
}

interface UpdateRequest {
  item_id: string;
  pictures: PictureEntry[];
}

/**
 * POST /api/ml/update-pictures
 *
 * Updates pictures on a ML listing with the exact order provided.
 *
 * For new images (source URL): uploads to ML first via /pictures/items/upload,
 * gets the picture_id, then uses that in the PUT. This is more reliable than
 * sending source URLs directly (ML servers may not reach Supabase).
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
    // Step 1: Upload new images to ML first, get their picture_ids
    const resolvedPictures: { id: string }[] = [];
    const uploadErrors: string[] = [];

    for (const pic of pictures) {
      if (pic.id) {
        // Existing ML picture — keep as is
        resolvedPictures.push({ id: pic.id });
      } else if (pic.source) {
        // New image — upload to ML first
        try {
          const uploaded = await mlUploadImageFromUrl(pic.source);
          resolvedPictures.push({ id: uploaded.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          uploadErrors.push(`Upload failed for ${pic.source.substring(0, 80)}: ${msg}`);
        }
      }
    }

    if (resolvedPictures.length === 0) {
      return NextResponse.json({
        item_id,
        success: false,
        error: 'No pictures could be resolved',
        upload_errors: uploadErrors,
      }, { status: 400 });
    }

    // Step 2: PUT the resolved picture IDs to the item
    const result = await mlPut(`/items/${item_id}`, { pictures: resolvedPictures });

    return NextResponse.json({
      item_id,
      success: true,
      pictures_count: resolvedPictures.length,
      upload_errors: uploadErrors.length > 0 ? uploadErrors : undefined,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ item_id, success: false, error: message }, { status: 500 });
  }
}

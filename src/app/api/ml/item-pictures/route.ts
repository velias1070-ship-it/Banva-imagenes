import { NextRequest, NextResponse } from 'next/server';
import { mlGet } from '@/lib/ml';

export const maxDuration = 30;

interface MlPicture {
  id: string;
  url?: string;
  secure_url?: string;
  size?: string;
  max_size?: string;
}

interface MlItemResponse {
  id: string;
  title?: string;
  status?: string;
  permalink?: string;
  pictures?: MlPicture[];
}

/**
 * Sube una URL de imagen de mlstatic a un tamaño mayor.
 * ML codifica el tamaño en el ultimo segmento antes de la extension:
 *   D_NQ_NP_..-I.webp (thumb)  ->  ..-F.webp (full ~1200)
 * Tambien fuerza https (algunos thumbnails vienen como http).
 */
function upgradeMlImage(url: string, code: 'O' | 'F' = 'F'): string {
  return url
    .replace(/^http:/, 'https:')
    .replace(/-[A-Z]\.(webp|jpg|jpeg|png)(\?.*)?$/i, `-${code}.$1$2`);
}

/**
 * GET /api/ml/item-pictures?item_id=MLCxxxxxxxxxx
 *
 * Trae EN VIVO desde MercadoLibre todas las fotos de una publicacion.
 * Read-only: no modifica nada. Se usa para el drill-down "ver todas las
 * fotos de esta variante" en la seccion de Variantes.
 */
export async function GET(request: NextRequest) {
  const itemId = request.nextUrl.searchParams.get('item_id')?.trim();

  if (!itemId) {
    return NextResponse.json({ error: 'Falta item_id' }, { status: 400 });
  }
  // Guard de forma: los item_id de ML son MLC + digitos. Evita llamadas
  // basura si llega un numero suelto (ej. un id de variacion o inventory_id).
  if (!/^ML[A-Z]\d+$/.test(itemId)) {
    return NextResponse.json(
      { error: `item_id con formato invalido: ${itemId} (se espera MLCxxxx)` },
      { status: 400 }
    );
  }

  try {
    const item = await mlGet<MlItemResponse>(
      `/items/${itemId}?attributes=id,title,status,permalink,pictures`
    );

    const pictures = (item.pictures || [])
      .map((p) => {
        const base = p.secure_url || p.url;
        if (!base) return null;
        return {
          id: p.id,
          url: upgradeMlImage(base, 'O'),
          full: upgradeMlImage(base, 'F'),
        };
      })
      .filter((p): p is { id: string; url: string; full: string } => p !== null);

    return NextResponse.json({
      item_id: item.id,
      title: item.title || '',
      status: item.status || '',
      permalink: item.permalink || '',
      count: pictures.length,
      pictures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

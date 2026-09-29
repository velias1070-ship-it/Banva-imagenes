import { NextResponse } from 'next/server';
import { resolveItemIdForSku } from '@/lib/ml';
import { clienteInventario, esVisible, inferCategory, listarFamilias, parseVariantLabel, slugify, type ProductGroup } from '@/lib/familias-ml';

// GET /api/productos
// Groups ML items by family_name (the way banvabodega does it in
// AdminComercial.tsx:596). Falls back to title-minus-last-word when an item
// has no family_name (legacy items not linked to ML's catalog).
//
// La lista son las publicaciones TRADICIONALES activas y pausadas. Un producto
// de Bodega sin publicación ya no entra (metía biblias, chocolates y soportes
// de celular); se encuentra con ?sku=.
//
// Productos table is used as a SECONDARY enrichment source: if a SKU exists
// in productos, we use its category/color/tamano fields to enrich the variant.
export async function GET(request: Request) {
  try {
    const supabase = clienteInventario();
    if (!supabase) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
    }

    // Exact-by-SKU escape hatch (Capa 3, server side): when ?sku=XXXX is present
    // we bypass the 2+ variant filter and return a SINGLE single-variant group
    // for that SKU, with its TRADITIONAL item_id resolved via resolveItemIdForSku.
    // Without the param the normal grouped behaviour is untouched.
    const skuQuery = new URL(request.url).searchParams.get('sku')?.trim();
    if (skuQuery) {
      const resolved = await resolveItemIdForSku(skuQuery);

      const [prodRes, mlRes] = await Promise.all([
        supabase
          .from('productos')
          .select('sku, nombre, categoria')
          .eq('sku', skuQuery)
          .maybeSingle(),
        supabase
          .from('ml_items_map')
          .select('item_id, titulo, family_name, status_ml, catalog_listing')
          .or(`sku_venta.eq."${skuQuery.replace(/["\\]/g, '')}",sku.eq."${skuQuery.replace(/["\\]/g, '')}"`)
          // Mismos filtros que el resolver y el listado agrupado: sin esto,
          // este fallback podia devolver titulo/item_id de una publicacion
          // cerrada en ML (activo=false) o de una fila de variacion.
          .eq('activo', true)
          .is('variation_id', null)
          // Un SKU tiene pocos avisos (tradicional, catálogo, algún duplicado):
          // 20 alcanza de sobra y queda lejos del tope de 1.000 filas.
          .limit(20),
      ]);

      if (prodRes.error) throw new Error(`productos: ${prodRes.error.message}`);
      if (mlRes.error) throw new Error(`ml_items_map: ${mlRes.error.message}`);

      const producto = prodRes.data || null;
      const mlItem = (mlRes.data ?? []).find(esVisible) ?? null;

      // Nothing matches this SKU anywhere → empty result.
      if (!producto && !mlItem) {
        return NextResponse.json([]);
      }

      const titulo: string = mlItem?.titulo || '';
      const familyName: string | null = mlItem?.family_name || null;
      const baseName = producto?.nombre || titulo || skuQuery;
      const parsed = parseVariantLabel(titulo, familyName);
      const color = parsed.color || skuQuery;
      const itemId = resolved.item_id || mlItem?.item_id || undefined;

      const group: ProductGroup = {
        base_name: baseName,
        // Distinto del slug de su familia: si no, la pantalla lo descarta por repetido.
        slug: `${slugify(baseName)}--${slugify(skuQuery)}`,
        tamano: '',
        categoria: inferCategory(baseName) || inferCategory(titulo, producto?.categoria),
        family_name: familyName,
        variantes: [
          {
            sku: skuQuery,
            color,
            color_slug: slugify(color),
            source: producto ? 'catalogo' : 'ml',
            item_id: itemId,
            titulo: titulo || undefined,
            status_ml: mlItem?.status_ml ?? null,
          },
        ],
      };

      return NextResponse.json([group]);
    }

    return NextResponse.json(await listarFamilias(supabase));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GET /api/productos] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

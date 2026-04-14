# Baseline — 2026-04-14

Captura del estado actual del pipeline para 9 jobs representativos. Sirve como "antes" para comparar contra cualquier cambio futuro (Fase 1: H1 + H3 + H6 del audit `audits/2026-04-14-audit-v2.md`).

## Snapshot

- **Commit del pipeline**: `3e4bb102aad6999710cfd2b6a209c0b7b28b405d` (main)
- **Fecha**: 2026-04-14
- **Ubicación de imágenes**: `benchmarks/2026-04-14-baseline/images/` (gitignored — descargar con `bash benchmarks/download-baseline.sh`)
- **Filenames**: `<jobIdShort>_<role>.<ext>` donde role ∈ {hero, swatch, output} y jobIdShort son los primeros 8 chars del UUID

## Metodología de comparación

Después de aplicar cambios, regenerar estos 9 jobs vía API:

```bash
for id in 59311c2c-77c4-423f-a368-e2b64278caa5 ...; do
  curl -sS -X POST "https://banva-app.vercel.app/api/projects/<projectId>/results/$id" \
    -H "Content-Type: application/json" -d '{}'
done
```

Descargar los nuevos outputs a `benchmarks/2026-04-14-experiment-<label>/images/` y comparar visualmente contra baseline.

**Criterios de éxito**:
- ✅ **Éxito**: ≥5/9 mejoran en la dimensión objetivo del cambio (drapeado, color, geometría, etc), ≤1 regresión clara
- ⚠️ **Neutral**: sin cambio visible → revertir (no mantener complejidad sin beneficio)
- ❌ **Regresión**: ≥2 empeoran → revertir inmediatamente

## Jobs

| # | Job ID | Proyecto | Categoría | Shot | Swatch | Status | Score | Attempts | Modelo | Known issue histórico |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `59311c2c` | Quilt Atenas | quilts | lifestyle (side-angle) | Canela (rayas horizontales) | approved | 0.95 | 12 | Pro | Orientation bug — rayas quedaron vertical antes de rotate 90°. Fix actual: stripe-axis classifier + pre-rotation de swatch. |
| 2 | `4dd41eb8` | Quilt Atenas | quilts | lifestyle (foot 3/4) | Fiora (wavy stripes) | approved | 0.95 | 4 | Pro | Hero 3/4 desde el pie — NO necesita rotación. El fix anterior sobre-rotó y después se arregló con el classifier nuevo. |
| 3 | `ce8f8632` | Quilt Atenas | quilts | detail (infografía) | Marrón (floral) | approved | 0.95 | 5 | gemini-brand | Pillow invention bug — detector clasificaba close-up con OEKO-TEX como lifestyle, edit mode inventaba 2 almohadas. Fix: detector nuevo clasifica como `detail` y usa `what_to_change_detail`. |
| 4 | `24e9e5c5` | Quilt Atenas | quilts | detail | Fiora (floral) | approved | 0.95 | 4 | Pro | Fold inventado — tiling 2×2 del swatch creaba fake edges que Gemini copiaba como capas extras de tela. Fix: skip tile en detail shots. |
| 5 | `be60f007` | Quilt Atenas | quilts | lifestyle (foot) | Celeste (floral) | approved | 0.95 | 2 | Pro | Pattern replacement bug — hero con leaves grandes + swatch floral chico, Gemini preservaba las leaves y solo recoloreaba. Fix: REEMPLAZO COMPLETO + "2D pattern not 3D" + discard qa feedback poison. |
| 6 | `b358c64f` | Quilt Atenas | quilts | lifestyle | Café (wavy) | flagged | 0.95 | 4 | Pro | Direction hint mislabel — pattern analyzer llamó "vertical" a rayas horizontales por el drape. Fix: skip DIRECTION_HINT regex para ROTATION_PRONE categories. **Nota: sigue en flagged por retries exhaustos, no por quality final.** |
| 7 | `98827373` | Bruselas Final | quilts | lifestyle + infografia text | Crema (stripes grises) | approved | 0.95 | 4 | gemini-brand | Brand fabric drift — flujo BRAND_ONLY revirtió la tela al hero original después del regen. Fix: fabric drift detection por mean RGB distance + fallback Sharp. |
| 8 | `f651b980` | Quilt Atenas | quilts | lifestyle (foot) | Canela (rayas horizontales) | approved | 0.93 | 2 | Pro | **Caso de referencia "bueno"** — hero foot-view con Canela, funcionó en reference mode sin rotación. Sirve como baseline de éxito para comparar contra jobs problemáticos con mismo swatch. |
| 9 | `28a3a069` | sábanas 144h | **sabanas** | lifestyle | Rojo | approved | 0.95 | 2 | Flash | Único non-quilt del set — único que usa Flash, no Pro. Sirve para detectar si los cambios de prompt impactan distinto en categorías con drapeado distinto (sabana fina vs quilt con relleno). |

## Observaciones del estado actual (para comparar después)

Lo que hay que mirar específicamente en cada job al comparar con el experiment post-Fase 1:

- **H1 (doc fix)** — no tiene impacto visual, solo consistencia docs. Skip en visual comparison.
- **H3 (physical_description en prompt)** — esperamos mejora en:
  - **Drapeado**: ¿el quilt se ve con grosor/caída correcta?
  - **Pliegues**: ¿hay pliegues anchos (quilts/plumones) o finos (sabanas)?
  - **Proporciones del producto**: ¿la silueta se mantiene?
- **Jobs que esperamos mejoren más con H3**:
  - `59311c2c`, `4dd41eb8`, `b358c64f`, `f651b980` (quilts lifestyle — drapeado sobre cama, diferencial de peso vs hero waffle)
  - `98827373` (quilt lifestyle con pillowcases visibles — ver si la caída del quilt body mejora)
  - `28a3a069` (sábana lifestyle — drapeado fluido vs el quilt groserizado del hero, si aplica)
- **Jobs donde H3 no debería impactar** (usar como control):
  - `ce8f8632`, `24e9e5c5` (detail shots — close-up de tela doblada, no hay drapeado sobre cama)
  - `be60f007` (el problema era pattern replacement, no drapeado)

## Reproducción

Para volver a descargar las mismas imágenes (las signed URLs expiran):

```bash
bash benchmarks/download-baseline.sh
```

El script es idempotente (skip files que ya existen) y usa solo el anon key de `.env.local` — no requiere credenciales extra.

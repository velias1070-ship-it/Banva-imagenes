# BANVA App — Generador de fotos de variantes de producto

## Contexto
BANVA vende textiles para el hogar en MercadoLibre Chile (sábanas, quilts, toallas, cubrecamas, cortinas, alfombras, frazadas y más categorías).
Cada producto tiene muchas variantes de color o diseño. Este sistema genera la foto de cada variante a partir de una foto base (hero) y una muestra de la tela (swatch), y las deja listas para revisar, aprobar y publicar en MercadoLibre.

> **El repo es público** (github.com/velias1070-ship-it/Banva-imagenes). Nunca poner en commits, PRs, docs ni comentarios llaves, tokens, identificadores de bases privadas ni datos de clientes. Las credenciales viven solo en variables de entorno (Vercel / `.env.local`, ignorado por git).

## Stack
- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript. Gestor de paquetes: npm.
- **Base de datos + Storage**: Supabase (Postgres + bucket `images`). Se usan DOS bases: la propia de esta app y la de bodega (ver «Datos»).
- **Generación de imágenes**: cadena de modelos por categoría, ChatGPT (OpenAI) y Gemini (ver «Quién genera qué»).
- **Análisis y verificación** (Gemini, texto): los analizadores (muestra, tipo de plano, patrón, textos) usan `gemini-2.5-flash` (`GEMINI_ANALYSIS_MODEL`); el verificador de fidelidad usa `gemini-2.5-pro` (`GEMINI_VERIFY_MODEL`).
- **Imagen**: Sharp (recorte, mosaico, aplanado, color, logo).
- **UI**: shadcn/ui + Tailwind CSS + Radix UI.
- **Despliegue**: Vercel. `process-next` y `process-qa` corren hasta 300 s (`maxDuration`); los crons están en `vercel.json`.

## Comandos
```bash
npm run dev          # http://localhost:3000
npm run build        # build de producción (valida tipos)
npm run lint         # eslint — el lint de main no está limpio: comparar contra main antes de atribuir un error a tu cambio
npx tsc --noEmit     # tipos
npx tsx --env-file=.env.local scripts/test-<x>.ts   # pruebas sueltas a mano (no hay `npm test` ni CI)
npm run golden       # golden set (ver .claude/rules/golden-set.md)
```

## Flujo principal
```
Subir heroes (fotos base) + swatches (muestras de tela), o traerlos desde MercadoLibre / por SKU
    -> /projects/{id}/generate: elegir heroes y swatches
    -> POST /api/projects/{id}/generate                      (crea el batch y los jobs)
    -> cadena serverless /api/batches/{batchId}/process-next  (1 job por invocación; se re-invoca sola con APP_URL)
        -> descarga imágenes -> buildPromptForMode() -> generateImageSmart() -> verificador -> sube el resultado
    -> /api/batches/{batchId}/process-qa                      (QA)
    -> /projects/{id}/results: aprobar / rechazar (PATCH) / regenerar (POST) en results/[jobId]; paso de marca (logo)
    -> ZIP de aprobadas (/api/projects/{id}/download) y /projects/{id}/publish (MercadoLibre)
```
**Dual-route sync** (convención del repo): todo cambio al pipeline de generación se aplica en `process-next/route.ts` Y en `results/[jobId]/route.ts`.

## Quién genera qué
- **`config/routing-rules.json`** define, por categoría, la cadena de modelos por intento (posición 0 = primer intento). Se valida con Zod (`src/lib/models/routing-rules.schema.ts`) contra `MODEL_REGISTRY` (`src/lib/models/registry.ts`). `selectModelId()` (`src/lib/image-providers.ts`) elige con esta precedencia: `swatch_overrides` > `shot_types` > `attempts` de la categoría > `default_chain`.
- Ese archivo también se edita desde `/admin/models` (`PUT /api/admin/models` lo commitea a GitHub y eso despliega): hacer `git pull` antes de tocarlo a mano.
- **Estado al 2026-09-29** (para decidir, leer el JSON, no este párrafo): ChatGPT primero (slot `gpt-image-2` = `gpt-image-2.5-sunburst`, calidad medium) en todas las categorías salvo `brand`; después Gemini Pro y Flash según categoría (frazadas y algunos `swatch_overrides` excluyen Flash); `brand` = Flash dos veces. La decisión y su base están en `_decision_2026_09_26` del propio JSON.
- **Respaldo dentro de la misma llamada**: si OpenAI falla (límite por minuto, saldo, timeout de 90 s, 5xx, sin imagen), `generateImageSmart()` responde con el Gemini más barato de lo que queda de la cadena y lo anota en el evento `PROVIDER_USED` como `fallback_from` / `fallback_code` / `fallback_error`. Para saber cuántas fotos salieron del respaldo, buscar ese campo en `pipeline_log`. No aplica con `forcedModelId` (solo benchmarks).
- **El prompt** sale de `buildPromptForMode()` (`src/lib/category-strategy.ts`), que despacha a `buildEditPrompt` / `buildReferencePrompt` / `buildFromScratchPrompt`. Es la ÚNICA fuente: la llaman `process-next`, la regeneración individual y el golden set. NUNCA duplicar esa lógica.
- **Paso de marca** (`BRAND_ONLY`, en `results/[jobId]`): hasta 2 llamadas a Gemini Flash con verificaciones (recorte, deriva de la tela, choque con la zona del logo) y luego el logo con Sharp.

## Costos: qué se anota y dónde mirar
- **OpenAI**: costo real calculado con los tokens de la respuesta (`src/lib/openai/images.ts`). **Gemini**: precio fijo por foto — Flash US$0,067 (`FLASH_COST_PER_IMAGE_USD` en `src/lib/providers/gemini.ts`, única fuente; los eventos viejos conservan el 0,045 con que se guardaron) y Pro US$0,134.
- **El gasto de un trabajo vive en su `pipeline_log`** (JSONB): un `PROVIDER_USED` por cada intento de generación y un `BRAND_COST` por cada foto que devuelve Gemini en el paso de marca (`data.cost_usd`). Las columnas `generation_jobs.cost_usd_actual`, `provider_used` y `model_id` se pisan en cada intento: guardan solo el último. No sumarlas ni usarlas para saber cuánto costó un trabajo.
- **Tope por trabajo**: `max_cost_per_job_usd` en `routing-rules.json`; `src/lib/cost-cap.ts` lo aplica desde el intento 1 sumando solo `PROVIDER_USED` (la marca no cuenta, a propósito).
- **Panel**: `/admin/costos` (`/api/admin/costs`) suma `EVENTOS_DE_GASTO` (`PROVIDER_USED` + `BRAND_COST`) y usa la columna solo de respaldo. No cubre las llamadas de texto (verificador, QA, análisis) ni las rutas sin telemetría (`edit-image`, `resize`, `use-as-hero`, aplanado de muestra).
- **Supabase corta cada lectura en 1.000 filas** aunque el código pida más (un `.limit(5000)` devolvió 1.000 de 8.566, medido 2026-09-29 sobre `generation_jobs` entera). Toda lectura que pueda pasar de 1.000 filas se pagina (ejemplo: `/api/admin/costs`, por `id`).

## Datos
- **Base propia** (`NEXT_PUBLIC_SUPABASE_URL`): `projects`, `generation_batches`, `generation_jobs` (con `pipeline_log`), `hero_shots`, `swatches`, `swatch_images`, `brands`, `skus`, `project_skus`, `category_templates`, `golden_runs` y la vista materializada `model_performance`. RPCs: `claim_next_job`, `append_pipeline_event`, `increment_batch_counts`, `refresh_model_performance`. Esquema en `supabase/migrations/`.
- **Base de bodega** (`INVENTORY_SUPABASE_URL` / `INVENTORY_SUPABASE_KEY`): el catálogo real de BANVA (`productos`, `ml_items_map`…). Esta app lee de ahí y **también escribe** `ml_items_map`: alta al crear un proyecto (`POST /api/projects`), `ml-listings`, `results-with-listings` y el sync `sync/ml-families`. Es producción de bodega: antes de cambiar esas escrituras, leer las reglas del repo `banvabodega`. Ojo: `ml_items_map.activo` no significa «viva en ML» (mirar `status_ml`).

## Variables de entorno (solo nombres; los valores están en Vercel y `.env.local`)
- Base propia: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Base de bodega: `INVENTORY_SUPABASE_URL`, `INVENTORY_SUPABASE_KEY`
- Gemini: `GEMINI_API_KEY`, `GEMINI_ENDPOINT`, `GEMINI_MODEL` (Flash de imagen), `GEMINI_MODEL_PRO`, `GEMINI_ANALYSIS_MODEL`, `GEMINI_VERIFY_MODEL`
- OpenAI: `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`
- App: `APP_URL` (URL con la que la cadena se re-invoca; si falta usa `VERCEL_URL`), `CRON_SECRET`, `ADMIN_EMAILS` (correos admin, separados por coma)
- Opcionales: `GITHUB_TOKEN` / `GITHUB_REPO` / `GITHUB_BRANCH` (el editor de `/admin/models`), `VIKI_WEBHOOK_URL` / `VIKI_SECRET` (aviso de regresión a Viki), `ADMIN_TEST_BYPASS` (solo pruebas locales; inerte en producción)

## Crons (`vercel.json`)
`health-check` (diario), `retry-rate-limited` (cada 10 min), `refresh-model-performance` (diario), `regression-alert` (cada 15 min; avisa a Viki por webhook si hay regresión).

## Autenticación
- Todo `/admin/*` pasa por `src/proxy.ts`: sesión de Supabase (magic link en `/login`) y correo dentro de `ADMIN_EMAILS`.
- Las rutas de `/api/admin/*` llaman `requireAdmin()` (`src/lib/admin-auth.ts`); los crons validan `CRON_SECRET`.
- Antes de agregar una ruta `/api/*` que gaste plata (Gemini / OpenAI) o escriba en la base de bodega, decidir su autenticación de forma explícita y dejarla escrita en el encabezado de la ruta.

## Producción
- URL: https://banva-app.vercel.app
- GitHub: https://github.com/velias1070-ship-it/Banva-imagenes
- Push a `main` = deploy automático en Vercel. No hay CI: trabajar en una rama, abrir PR y correr tipos y lint en local antes de pedir el merge.
- Commits: `tipo(área): descripción` en español, con `(#PR)` al final cuando se hace squash.

## Reglas detalladas (`.claude/rules/`)
- `prompts.md` — convenciones de prompt por categoría. El 2026-09-29 solo se corrigieron los punteros a la función que arma el prompt (`buildPromptForMode()`)
- `gemini-api.md` — configuración de Gemini/OpenAI y costos. El 2026-09-29 solo se verificaron contra el código los modelos por defecto, el respaldo, el precio por imagen y los tiempos máximos de `process-next`; lo demás del archivo (límites de velocidad, costo del verificador y del QA, errores conocidos) no se revisó
- `qa-scoring.md` — criterios de QA y scoring
- `agents.md` — arquitectura de subagentes y optimización de contexto
- `errors-resolved.md` — log de errores resueltos
- `feedback-loop.md` — sistema de aprendizaje por feedback
- `golden-set.md` — golden set y benchmarks

Si cambia el modelo por defecto, su precio o la cadena, actualizar `gemini-api.md` y este archivo a la vez: tienen que decir lo mismo.

# BANVA App — Generador de Variantes de Producto

## Contexto
BANVA vende textiles para el hogar en MercadoLibre Chile (sabanas, quilts, toallas, cubrecamas, cortinas, almohadas, y 10+ categorias mas).
Cada producto tiene 5-15 variantes de color. Este sistema genera fotos de las variantes automaticamente usando Gemini API.

## Stack
- **Framework**: Next.js 16.1.6 (App Router, TypeScript)
- **Database + Storage**: Supabase (PostgreSQL + bucket "images")
- **Image Generation**: Google Gemini API (`gemini-3-pro-image-preview`)
- **Image Processing**: Sharp 0.34.5 (dark swatch detection)
- **Deployment**: Vercel (serverless, 60s timeout free tier)
- **UI**: shadcn/ui + Tailwind CSS + Radix UI

## Flujo Principal
```
Upload heroes (fotos base) + swatches (muestras de color/patron)
    -> Seleccionar heroes y swatches en /generate
    -> POST /api/projects/{id}/generate (crea batch + jobs)
    -> Serverless chain: /api/batches/{batchId}/process-next
        -> Para cada job: descarga imagenes, buildPrompt(), llama Gemini, sube resultado
    -> Review en /results (aprobar/rechazar/regenerar)
    -> Download ZIP de aprobadas
```

## Estructura Clave
```
src/
  app/api/
    projects/[id]/generate/route.ts   <- buildPrompt() SINGLE SOURCE OF TRUTH
    projects/[id]/results/[jobId]/     <- regenerar individual
    batches/[batchId]/process-next/    <- serverless chain (1 job por invocacion)
  lib/
    gemini/client.ts                   <- API client (2 imagenes + prompt)
    image-processing.ts                <- isSwatchDark(), enhanceSwatchContrast() (unused)
    constants.ts                       <- categorias, shot types, costos
    supabase/                          <- admin.ts, server.ts, client.ts
```

## Variables de Entorno (requeridas)
- `NEXT_PUBLIC_SUPABASE_URL` — URL de Supabase
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Service role (background ops)
- `GEMINI_API_KEY` — API key de Google Gemini
- `GEMINI_MODEL` — Modelo (default: gemini-3-pro-image-preview)
- `GEMINI_ENDPOINT` — Base URL de la API
- `APP_URL` — URL de la app en produccion (para serverless chain self-invoke)

## Produccion
- URL: https://banva-app.vercel.app
- GitHub: https://github.com/velias1070-ship-it/Banva-imagenes.git
- Push a main = auto-deploy en Vercel

## REGLA CRITICA: Single Source of Truth
`buildPrompt()` en `src/app/api/projects/[id]/generate/route.ts` es la UNICA funcion para construir prompts.
Todos los demas archivos la IMPORTAN dinamicamente. NUNCA duplicar esta logica.
NOTA: `src/lib/inngest/functions/batch-generate.ts` tiene un buildPrompt() DUPLICADO y DESACTUALIZADO — esta deprecated, no usar.

## Documentacion Detallada
Ver `.claude/rules/` para reglas especificas:
- `prompts.md` — Convenciones de prompt por categoria
- `gemini-api.md` — Configuracion de Gemini, errores conocidos
- `qa-scoring.md` — Criterios de QA y scoring
- `agents.md` — Arquitectura de subagentes y optimizacion de contexto
- `errors-resolved.md` — Log de errores resueltos
- `feedback-loop.md` — Sistema de aprendizaje por feedback

# Gemini y OpenAI (ChatGPT) — Configuracion y Errores Conocidos

> **Alcance de la revision del 2026-09-29:** se verificaron contra el codigo los modelos por defecto, el respaldo de ChatGPT a Gemini, el precio por imagen y los tiempos maximos de `process-next`. Lo demas (limites de velocidad, costo del verificador y del QA, errores conocidos) viene de antes y no se re-reviso.

## Configuracion

| Parametro | Valor | Env Var |
|-----------|-------|---------|
| Modelo ChatGPT (imagen) | `gpt-image-2.5-sunburst`, calidad `medium` (es el slot `gpt-image-2` del registro de modelos) | `OPENAI_IMAGE_MODEL` |
| Modelo Gemini Flash (imagen) | `gemini-3.1-flash-image-preview` | `GEMINI_MODEL` |
| Modelo Gemini Pro (imagen) | `gemini-3-pro-image-preview` | `GEMINI_MODEL_PRO` |
| Modelo BRAND_ONLY | `gemini-3.1-flash-image-preview` (Flash, decisión provisoria validada con n=3 en abr-2026) | `GEMINI_MODEL` |
| Modelo analisis (muestra/plano/patron/textos) | `gemini-2.5-flash` (default del codigo; los llamadores tambien lo piden explicito con `modelOverride`) | `GEMINI_ANALYSIS_MODEL` |
| Modelo verifier (swatch fidelity) | `gemini-2.5-pro` | `GEMINI_VERIFY_MODEL` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models` | `GEMINI_ENDPOINT` |
| API Key | (secret) | `GEMINI_API_KEY` |
| Temperatura | 0.2 (edit), 0.4 (reference) — ajustada por `getEffectiveTemperature()` | Hardcoded en `category-strategy.ts` |
| Response Modalities | `['IMAGE', 'TEXT']` | Hardcoded en `gemini/client.ts` |
| Output Resolution | 1200x1200 | Especificado en prompt + post-process con Sharp |

### Como se elige el modelo (estado 2026-09-29)

- **Manda la cadena de `config/routing-rules.json`**, por categoria (ver `CLAUDE.md` §«Quién genera qué»). Hoy ChatGPT va primero en todas las categorias salvo `brand`; despues Gemini Pro y Flash (cadena por defecto: `gpt-image-2` → `gemini-pro` → `gemini-flash`; `frazadas`: ChatGPT y dos veces Pro; `brand`: dos veces Flash). Para decidir algo, leer el JSON: esta lista se desactualiza.
- **Un intento = una posicion de la cadena.** `job.attempt` sube por trabajo (`process-next` re-intenta con el verificador en el medio) y `selectModelId()` (`src/lib/image-providers.ts`) toma el modelo de esa posicion; si el intento pasa del largo de la cadena, repite el ultimo.
- **Respaldo dentro de la misma llamada:** si OpenAI falla, `generateImageSmart()` responde con el Gemini mas barato de lo que queda de la cadena y lo anota en `PROVIDER_USED` (`fallback_from`, `fallback_code`, `fallback_error`).
- **Herencia que confunde:** `proThreshold` (en `process-next` y en `results/[jobId]`) ya no elige el modelo, porque cada adaptador fija el suyo. Solo pone la etiqueta `Flash`/`Pro` del evento `GENERATION_START`, que puede decir `Flash` cuando genero ChatGPT. El modelo que genero de verdad esta en `PROVIDER_USED`.
- **Costo y calidad** (nota de abr-2026, no re-medida): Pro cuesta el doble de Flash por foto (US$0,134 contra US$0,067) y en el ranking de Arena.ai Flash daba textura de tela 4/5 contra 5/5 de Pro (ver `research/2026-04-14-ai-image-pipelines-ecommerce-textile.md`).
- **BRAND_ONLY usa Flash (no Pro)**: el flujo brand overlay con re-rendering corre con `gemini-flash` por defecto. Decisión provisoria basada en n=3 jobs (abr-2026): approval rate 66.7%, avg qa_score 0.867. El único fail observado fue con Pro y por `product_fidelity = 0.0` (caso `PATRON`/swatch floral ignorado), no por capacidad del modelo. Pro no resuelve ese caso. Re-evaluar cuando `model_performance` view tenga >30 brand jobs. Configurado en `config/routing-rules.json` → `categories.brand.attempts`.
- **Degradacion conocida de Flash** (nota heredada, no re-verificada): "Nano Banana 2" tiene drift documentado despues de 3-4 ediciones iterativas.

Regla: si tocas el modelo por defecto, su precio o la cadena, actualiza ESTE archivo Y `CLAUDE.md` simultaneamente — los dos tienen que decir lo mismo.

## Request Format

```typescript
// Archivo: src/lib/gemini/client.ts
const parts = [
  { inline_data: { mime_type: heroMimeType, data: heroBase64 } },   // Image 1 (hero)
  { inline_data: { mime_type: swatchMimeType, data: swatchBase64 } }, // Image 2 (swatch)
  { text: promptText },                                              // Prompt
];

const body = {
  contents: [{ parts }],
  generationConfig: {
    responseModalities: ['IMAGE', 'TEXT'],
    temperature: 0.2,
  },
};
```

**MAXIMO 2 imagenes.** Gemini ignora la 3ra imagen si se envia.

## Response Format

```
data.candidates[0].content.parts[] ->
  - { inlineData: { data: base64, mimeType: "image/png" } }  // Imagen generada
  - { text: "..." }                                           // Comentario (opcional)
```

## Rate Limiting

- **Maximo**: 9 requests por minuto
- **Delay**: 7 segundos entre requests
- **Serverless chain**: 1 job por invocacion de Vercel (hasta 300 s: `maxDuration` de `process-next`)
- **Self-invocation**: Usa `APP_URL` env var para chainear al siguiente job

## Costos

Para saber cuanto se gasto de verdad: `/admin/costos` (`CLAUDE.md` §«Costos: qué se anota y dónde mirar»). Lo de abajo es el precio de cada llamada.

- **ChatGPT (OpenAI)**: sin precio fijo. Se calcula con los tokens de cada respuesta (`src/lib/openai/images.ts`: texto US$5/M, imagen de entrada US$8/M, salida US$30/M).
- **Gemini Flash (imagen)**: US$0,067 por foto (1K = 1.120 tokens a US$60/M). Unica fuente: `FLASH_COST_PER_IMAGE_USD` en `src/lib/providers/gemini.ts`. Hasta el 2026-09-29 se usaba US$0,045 (precio de 0,5K, que la app nunca pide); los eventos ya guardados conservan ese valor.
- **Gemini Pro (imagen)**: US$0,134 por foto.
- **Click de marca (BRAND_ONLY)**: hasta 2 fotos de Flash, o sea US$0,134 como maximo en fotos (cada una queda como `BRAND_COST`), mas las llamadas de texto de las verificaciones, que no se anotan.
- **Verificador (`gemini-2.5-pro`), QA y analisis de muestra**: llamadas de texto que hoy no se anotan en ningun lado. Las cifras que estaban aca (~US$0,08-0,10 por verificacion, ~US$0,002-0,005 por analisis) no se re-midieron.
- **Trabajo tipico**: medido 2026-09-29 17:24 UTC sobre `generation_jobs` con `updated_at` en los ultimos 30 dias, solo los 513 trabajos con eventos de gasto: US$0,079 en promedio (US$40,50 en total), sin llamadas de texto y con Flash a US$0,045 en los eventos viejos. Las cifras de "trabajo con reintentos" y "maximo" que habia aca eran estimaciones de abril y no se re-midieron: usar `/admin/costos`.

## Storage (Supabase)

- Bucket: `images`
- Heroes: `projects/{projectId}/heroes/{uuid}.{ext}`
- Swatches: `projects/{projectId}/swatches/{uuid}.{ext}`
- Generated: `projects/{projectId}/generated/{jobId}.png`
- Operaciones: `download()`, `upload(path, buffer, { contentType, upsert: true })`

## Errores Conocidos y Soluciones

### 1. Base64 Prefix -> Error 400
**Sintoma**: Gemini devuelve HTTP 400 "Invalid base64"
**Causa**: El base64 tiene prefijo `data:image/png;base64,`
**Solucion**: Strip prefix antes de enviar:
```typescript
const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
```

### 2. Imagen muy grande -> Timeout
**Sintoma**: Request timeout o OOM
**Causa**: Imagenes originales >4MB producen base64 >5MB
**Solucion**: Resize a 1200x1200 max antes de encode con Sharp

### 3. Batch timeout en Vercel (60s)
**Sintoma**: Solo se procesan 1-2 de N jobs, resto queda "pending"
**Causa**: Multiples jobs en una sola invocacion exceden 60s
**Solucion**: Serverless chain pattern en `/api/batches/[batchId]/process-next`
- Cada invocacion procesa 1 job (~25s)
- Al terminar, hace fetch() a si mismo para el siguiente
- Requiere `APP_URL` env var (VERCEL_URL no es confiable para self-invoke)

### 4. Chain se detiene despues de 1 job
**Sintoma**: Solo 1 job procesado, chain no continua
**Causa**: `VERCEL_URL` no resuelve correctamente para self-invocation
**Solucion**: Agregar `APP_URL=https://banva-app.vercel.app` como env var en Vercel

### 5. No image in response
**Sintoma**: `success: false, error: "No image in Gemini response"`
**Causa**: Gemini a veces devuelve solo texto sin imagen (prompt ambiguo o safety filter)
**Solucion**: Reintentar. Si persiste, revisar prompt por contenido que active safety filters

### 6. HTTP 429 Rate Limit
**Sintoma**: "Resource has been exhausted"
**Solucion**: Esperar 60s y reintentar. Maximo 2 retries.

## Serverless Chain — Detalle

```
POST /api/projects/{id}/generate
  -> Crea batch + jobs en DB
  -> after() -> startBatchProcessing(batchId)
    -> fetch /api/batches/{batchId}/process-next

POST /api/batches/{batchId}/process-next
  -> after() -> processOneJob(batchId)
    -> Toma 1 pending job
    -> Descarga hero + swatch de Storage
    -> buildPromptForMode() (src/lib/category-strategy.ts)
    -> generateImageSmart() (elige el modelo de la cadena y llama a ChatGPT o a Gemini)
    -> Sube resultado a Storage
    -> Actualiza job status (approved/error)
    -> Actualiza batch counts
    -> fetch() a si mismo para el siguiente job
    -> Si no hay mas pending -> batch status = completed
```

**`maxDuration`**: `generate` 60 s; `process-next` y `process-qa` 300 s.
**`after()`** de `next/server` para procesamiento background que retorna 200 inmediatamente.

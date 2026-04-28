# Gemini API — Configuracion y Errores Conocidos

## Configuracion

| Parametro | Valor | Env Var |
|-----------|-------|---------|
| Modelo default (attempt 0) | `gemini-3.1-flash-image-preview` | `GEMINI_MODEL` |
| Modelo escalada (retry) | `gemini-3.1-pro-preview` | `GEMINI_MODEL_PRO` |
| Modelo BRAND_ONLY | `gemini-3.1-flash-image-preview` (Flash, decisión provisoria validada con n=3 en abr-2026) | `GEMINI_MODEL` |
| Modelo analisis (shot/stripe/pattern) | `gemini-2.0-flash` default, override a `gemini-2.5-flash` por caller | `GEMINI_ANALYSIS_MODEL` |
| Modelo verifier (swatch fidelity) | `gemini-2.5-pro` | `GEMINI_VERIFY_MODEL` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models` | `GEMINI_ENDPOINT` |
| API Key | (secret) | `GEMINI_API_KEY` |
| Temperatura | 0.2 (edit), 0.4 (reference) — ajustada por `getEffectiveTemperature()` | Hardcoded en `category-strategy.ts` |
| Response Modalities | `['IMAGE', 'TEXT']` | Hardcoded en `gemini/client.ts` |
| Output Resolution | 1200x1200 | Especificado en prompt + post-process con Sharp |

### Por que Flash es el default y no Pro

- **Costo**: Flash ~$0.045/img vs Pro ~$0.134/img (3x diferencia).
- **Calidad**: Flash da textura de tela 4/5 vs Pro 5/5 (ranking Arena.ai, ver `research/2026-04-14-ai-image-pipelines-ecommerce-textile.md`). Para la mayoria de las categorias la diferencia no justifica el 3x.
- **Escalada automatica**: el pipeline escala a Pro en estos casos:
  1. Retry despues de fallar verifier 2.5 Pro (`process-next/route.ts` — `useProModel: true` en retries).
  2. Cualquier job con `attempt >= proThreshold` (umbral por categoria en `category-strategy.ts`).
- **BRAND_ONLY usa Flash (no Pro)**: el flujo brand overlay con re-rendering corre con `gemini-flash` por defecto. Decisión provisoria basada en n=3 jobs (abr-2026): approval rate 66.7%, avg qa_score 0.867. El único fail observado fue con Pro y por `product_fidelity = 0.0` (caso `PATRON`/swatch floral ignorado), no por capacidad del modelo. Pro no resuelve ese caso. Re-evaluar cuando `model_performance` view tenga >30 brand jobs. Configurado en `config/routing-rules.json` → `categories.brand.attempts`.
- **Degradacion conocida de Flash**: "Nano Banana 2" tiene drift documentado despues de 3-4 ediciones iterativas. Por eso el retry escala a Pro en vez de reintentar con Flash.

Regla: si tocas el default, actualiza ESTE archivo Y `CLAUDE.md` simultaneamente — los dos tienen que decir lo mismo.

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
- **Serverless chain**: 1 job por invocacion de Vercel (60s timeout)
- **Self-invocation**: Usa `APP_URL` env var para chainear al siguiente job

## Costos

- **Flash (attempt 0 default)**: ~$0.045 USD/imagen. Formula: input tokens (~$0.015) + output image (~$0.025) + Claude orchestration (~$0.005).
- **Pro (retry + brand)**: ~$0.134 USD/imagen. 3x mas caro por el re-rendering de mayor calidad.
- **Verifier 2.5 Pro**: ~$0.08-0.10/verificacion (3 imagenes de input, respuesta JSON).
- **Analisis (shot type, stripe axis, pattern compare)**: ~$0.002-0.005 cada uno, gemini-2.0-flash o 2.5-flash segun caller.
- **Job tipico "happy path" (Flash + verifier pass + QA)**: ~$0.15.
- **Job tipico con retries (Flash + verifier fail + Pro + verifier pass + QA)**: ~$0.40-0.50.
- **Job con max retries (hasta 4 intentos Pro + verificaciones)**: hasta ~$1.00-1.20.
- **Click de brand button**: ~$0.24 adicional (2 Pro attempts + bbox detection).

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
    -> buildPrompt() (imported from generate/route)
    -> generateImage() (Gemini API call)
    -> Sube resultado a Storage
    -> Actualiza job status (approved/error)
    -> Actualiza batch counts
    -> fetch() a si mismo para el siguiente job
    -> Si no hay mas pending -> batch status = completed
```

**maxDuration = 60** en ambos endpoints.
**`after()`** de `next/server` para procesamiento background que retorna 200 inmediatamente.

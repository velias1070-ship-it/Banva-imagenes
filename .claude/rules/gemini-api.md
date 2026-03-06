# Gemini API — Configuracion y Errores Conocidos

## Configuracion

| Parametro | Valor | Env Var |
|-----------|-------|---------|
| Modelo | `gemini-3-pro-image-preview` | `GEMINI_MODEL` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models` | `GEMINI_ENDPOINT` |
| API Key | (secret) | `GEMINI_API_KEY` |
| Temperatura | 0.2 | Hardcoded en client.ts |
| Response Modalities | `['IMAGE', 'TEXT']` | Hardcoded |
| Output Resolution | 1024x1024 | Especificado en prompt |

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

- **Estimado**: $0.045 USD por imagen generada
- Formula: Gemini input tokens (~$0.015) + output image (~$0.025) + Claude orchestration (~$0.005)

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

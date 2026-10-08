# Gemini y OpenAI (ChatGPT) — Configuracion y Errores Conocidos

> **Alcance de la revision del 2026-09-29:** se verificaron contra el codigo los modelos por defecto, el respaldo de ChatGPT a Gemini, el precio por imagen y los tiempos maximos de `process-next`. Lo demas (limites de velocidad, costo del verificador y del QA, errores conocidos) viene de antes y no se re-reviso.
>
> **Cambio del 2026-10-08 (Flash → Nano Banana 2.1):** se verifico el modelo por defecto y su precio contra el codigo, y el modelo nuevo con llamadas reales a la API con las mismas entradas que la app (ver «Costos»). El codigo de la app en si no se corrio contra la API real: eso queda para la primera generacion despues del deploy. Nada mas se re-reviso.

## Configuracion

| Parametro | Valor | Env Var |
|-----------|-------|---------|
| Modelo ChatGPT (imagen) | `gpt-image-2.5-sunburst`, calidad `medium` (es el slot `gpt-image-2` del registro de modelos) | `OPENAI_IMAGE_MODEL` |
| Modelo Gemini Flash (imagen) | `gemini-nano-banana-2.1` (Nano Banana 2.1; antes `gemini-3.1-flash-image-preview`) | `GEMINI_MODEL` |
| Modelo Gemini Pro (imagen) | `gemini-3-pro-image-preview` | `GEMINI_MODEL_PRO` |
| Modelo BRAND_ONLY | `gemini-nano-banana-2.1` (Flash, decisión provisoria validada con n=3 en abr-2026 sobre el Flash anterior; con Nano Banana 2.1 solo se reprodujeron 2 pasos de marca el 2026-10-08, ver «Costos») | `GEMINI_MODEL` |
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
- **Costo y calidad** (nota de abr-2026 sobre el Flash anterior; el precio se actualizo el 2026-10-08, la calidad no se re-midio): Pro cuesta 2,6 veces lo que Flash por foto (US$0,134 contra US$0,052) y en el ranking de Arena.ai el Flash anterior daba textura de tela 4/5 contra 5/5 de Pro (ver `research/2026-04-14-ai-image-pipelines-ecommerce-textile.md`).
- **BRAND_ONLY usa Flash (no Pro)**: el flujo brand overlay con re-rendering corre con `gemini-flash` por defecto. Decisión provisoria basada en n=3 jobs (abr-2026): approval rate 66.7%, avg qa_score 0.867. El único fail observado fue con Pro y por `product_fidelity = 0.0` (caso `PATRON`/swatch floral ignorado), no por capacidad del modelo. Pro no resuelve ese caso. Re-evaluar cuando `model_performance` view tenga >30 brand jobs. Configurado en `config/routing-rules.json` → `categories.brand.attempts`.
- **Degradacion conocida de Flash** (nota heredada del Flash anterior, "Nano Banana 2"; no re-verificada con Nano Banana 2.1): tiene drift documentado despues de 3-4 ediciones iterativas.
- **Flash pasa a Nano Banana 2.1 (2026-10-08).** El id sale de UN solo lugar: la constante `GEMINI_MODEL` que exporta `src/lib/gemini/client.ts` (la leen el adaptador y la etiqueta `model_id` de `results/[jobId]`). **Si `GEMINI_MODEL` esta definida en Vercel, manda sobre el default del codigo**: al cambiar de modelo hay que cambiar tambien esa variable (Production), no alcanza con el codigo. El slot sigue llamandose `gemini-flash` (lo usan `routing-rules.json` y `provider_used`); los trabajos nuevos guardan `model_id = gemini-nano-banana-2.1` y los viejos conservan el id anterior. El cron `regression-alert` agrupa por `(model_id, case_signature)` y alerta desde 20 trabajos terminales por grupo: para el Flash nuevo parte de cero.
- **Pendiente: Pro sigue en `gemini-3-pro-image-preview`**, que la tabla de deprecaciones de Google tambien da de baja desde 2026-06-25 (aun asi responde). Su reemplazo es `gemini-3-pro-image`; no se probo.

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
- **Gemini Flash (imagen) = Nano Banana 2.1**: US$0,052 por foto. Cobra por tokens: entrada US$1,50/M, texto y "pensamiento" de salida US$7,50/M, imagen de salida US$30/M (1K = 1.120 tokens), y el modelo siempre piensa (no se puede apagar). Medido 2026-10-08, 5 llamadas reales directas a la API con las mismas entradas que la app (foto base, muestra ya procesada, instruccion guardada y temperatura del trabajo; 3 generaciones y 2 pasos de marca, una sola vez cada una): US$0,049-0,057, promedio 0,052; el Flash anterior con las mismas 3 entradas de generacion: US$0,069-0,070. Unos 400-600 tokens de salida por llamada vienen sin desglose y se contaron a precio de texto (si fueran de imagen: hasta ~0,067). No se comparo con la factura de Google. Tarda mas: 15,8-20,9 s por generacion contra 10,3-14,9 s del Flash anterior (los mismos 3 casos, desde un Mac). Unica fuente del precio: `FLASH_COST_PER_IMAGE_USD` en `src/lib/providers/gemini.ts`. Los eventos ya guardados conservan el valor con que se anotaron (0,045 hasta el 2026-09-29; 0,067 hasta este cambio).
- **Gemini Pro (imagen)**: US$0,134 por foto.
- **Click de marca (BRAND_ONLY)**: hasta 2 fotos de Flash, o sea US$0,104 como maximo en fotos (2 x 0,052; cada una queda como `BRAND_COST`), mas las llamadas de texto de las verificaciones, que no se anotan.
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

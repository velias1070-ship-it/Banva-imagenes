# Errores Resueltos — Log Historico

Errores descubiertos y solucionados durante el desarrollo. Documentados para no redescubrirlos.

## Tabla de Errores

| # | Error | Sintoma | Causa | Solucion | Archivo |
|---|-------|---------|-------|----------|---------|
| 1 | Base64 prefix | Gemini HTTP 400 "Invalid base64" | String base64 incluye prefijo `data:image/...;base64,` | Strip prefix con regex antes de enviar | `lib/gemini/client.ts` |
| 2 | Imagen muy grande | Timeout / OOM en Vercel | Imagenes >4MB producen base64 >5MB | Resize a 1200x1200 max con Sharp antes de encode | `lib/image-processing.ts` |
| 3 | Vercel 60s timeout | Batch incompleto: 2 de 8 jobs procesados | Multiples jobs en una sola invocacion serverless | Serverless chain: 1 job por invocacion, self-invoke para siguiente | `api/batches/[batchId]/process-next/route.ts` |
| 4 | Chain stops after 1 | Solo 1 job se procesa, chain no continua | `VERCEL_URL` no resuelve bien para self-invocation | Agregar `APP_URL` env var con URL real de produccion | `api/batches/[batchId]/process-next/route.ts` |
| 5 | Dark swatch gris | Quilt negro sale gris con patron arabesque | CLAHE enhance reemplaza Image 2 con grayscale | Revertir a prompt-only approach: swatch original + dark handling note | `api/projects/[id]/generate/route.ts` |
| 6 | 3-image approach | Gemini ignora la tercera imagen | Modelo no procesa bien >2 imagenes inline | Mantener SOLO 2 imagenes (hero + swatch), ajustar prompt | `lib/gemini/client.ts` |
| 7 | TypeScript cast error | Build fail en download route | `as { filename: string }` rechaza array type | Usar `as unknown as { type }` pattern | `api/projects/[id]/download/route.ts` |
| 8 | Swatch lifestyle | Output copia escena del swatch (dormitorio) en vez de hero (close-up) | Image 2 es foto de producto completa, Gemini copia composicion | Agregar warning en prompt: "Image 2 may be FULL PRODUCT PHOTO" | `api/projects/[id]/generate/route.ts` |
| 9 | Quilting pattern persiste | Color cambia pero patron mandala del hero se mantiene | Textura 3D embossed demasiado fuerte para que Gemini la reemplace | Enfatizar en RULE #2 que stitch pattern DEBE cambiar. Limitacion parcial del modelo. | `api/projects/[id]/generate/route.ts` |
| 10 | GitHub push auth | Permission denied al hacer git push | No hay SSH key ni credential helper configurado | Crear Personal Access Token (classic, repo scope, 90 dias), usar como password HTTPS | N/A (configuracion) |
| 11 | npm global install fail | Permission denied para `npm install -g vercel` | Permisos de sistema en macOS | Usar `npx vercel` en vez de instalacion global | N/A (configuracion) |
| 12 | Vercel deploy network | EADDRNOTAVAIL en primer intento de deploy | Error de red transitorio | Reintentar despues de 5 segundos | N/A (configuracion) |

## Notas

### Patron comun: Los errores de Gemini se resuelven en el prompt
La mayoria de los problemas de calidad de imagen se solucionan ajustando el prompt, NO procesando imagenes.
Intentos de pre-procesar imagenes (CLAHE, enhance, 3ra imagen) generalmente empeoran los resultados.

### Patron comun: Vercel serverless requiere patron chain
Cualquier operacion que tome >60s debe dividirse en invocaciones individuales encadenadas.
Cada invocacion retorna 200 inmediatamente con `after()` y se auto-invoca para la siguiente.

### Patron comun: Variables de entorno como fallback
Siempre usar `process.env.APP_URL || process.env.VERCEL_URL || 'http://localhost:3000'`
No confiar solo en VERCEL_URL para self-invocation.

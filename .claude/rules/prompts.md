# Convenciones de Prompt — BANVA Image Generation

## REGLA SUPREMA: EL SWATCH ES EL PRODUCTO

**El swatch representa el producto real que BANVA vende.** Cada swatch es una foto del producto fisico.
Los agentes DEBEN analizar el swatch para determinar:
- Que producto es (quilt, sabana, toalla, etc.)
- Que patron tiene (basket weave, mandala, liso, floral, etc.)
- Que color/paleta tiene
- Que distribucion tiene el patron (uniforme, solo bordes, estampado parcial)

**La imagen generada DEBE ser fiel al swatch.** Si hay CUALQUIER diferencia entre el patron del swatch y el patron en la imagen generada, esa imagen esta **INVENTANDO UN PRODUCTO QUE NO EXISTE**.

Esto significa:
- Si el swatch muestra basket weave rojo → la imagen DEBE mostrar basket weave rojo
- Si la imagen generada muestra mandala (porque el hero tenia mandala) → RECHAZADA por invencion de producto
- Incluso un 10% de patron del hero filtrandose al output = producto inventado = RECHAZADA
- Es preferible una imagen SIN modelo pero con producto correcto, que una imagen CON modelo pero con producto incorrecto

### Jerarquia de Prioridades
1. **Fidelidad al swatch (producto)** — MAXIMA, no negociable
2. **Composicion comercial** — Buena foto de producto, usable en MercadoLibre
3. **Fidelidad al hero (composicion)** — Deseable pero sacrificable si compromete el producto

## Arquitectura del Prompt

Cada prompt tiene 3 capas:
1. **Intro + Image descriptions** — Contexto de Image 1 (hero) e Image 2 (swatch)
2. **RULE #1: Product Fidelity** — El swatch es el producto, replicar EXACTAMENTE
3. **RULE #2: Composition Lock** — Preservar composicion del hero
4. **RULE #3: Category-specific** — Que cambiar segun tipo de producto
5. **Final Check** — Verificacion antes de output

## Single Source of Truth

`buildPrompt()` en `src/app/api/projects/[id]/generate/route.ts`
Parametros: `(category, swatchName, colorDescription, shotType, isDarkSwatch)`
Temperatura: **0.2** (determinista, NO subir)
Resolucion: 1024x1024

## Categorias con Reglas Especializadas

### QUILTS
- Producto: quilt (cobertor liviano) + fundas de almohada
- **CRITICO**: El swatch define el patron de quilting correcto
- Si swatch patron ≠ hero patron → usar TIER 2 directamente (no perder tiempo en Tier 1)
- Si swatch patron = hero patron (solo cambia color) → Tier 1 funciona bien
- Las fundas de almohada tambien deben cambiar patron + color
- NO cambiar: superficie debajo del quilt (sabana, colchon)

### SABANAS
- Producto: juego de sabanas (fundas + sabana bajera + sabana plana)
- Image 2 puede mostrar DIFERENTES patrones en cada pieza
- Fundas -> patron de fundas del swatch
- Sabana bajera -> patron de sabana bajera del swatch (a menudo distinto)
- Si solo un patron visible -> aplicar a todas las piezas

### DEFAULT (13 categorias restantes)
- Cambiar TODAS las superficies textiles visibles
- Aplicar patron/color de Image 2 a todo el producto

## Deteccion de Producto por Swatch

Los agentes deben analizar el swatch ANTES de generar para determinar:

1. **Tipo de patron**: liso, quilting (basket weave, mandala, chevron, etc.), estampado, bordado
2. **Distribucion**: uniforme en toda la tela, solo bordes, parcial
3. **Color dominante**: para validar que el output tenga el color correcto
4. **Textura 3D**: si el swatch muestra textura embossed, la imagen generada DEBE replicarla

Si el patron del swatch es DIFERENTE al patron del hero:
→ El sistema DEBE usar Tier 2 (generacion desde cero) automaticamente
→ No intentar edit mode porque SIEMPRE filtra el patron del hero

Si el patron del swatch es IGUAL al del hero (solo cambia color):
→ Edit mode (Tier 1) funciona perfectamente

## Dark Swatch Handling

**Deteccion**: `isSwatchDark()` en `image-processing.ts` — brightness promedio < 115 (escala 0-255)
**Approach**: Solo prompt (NO image enhancement)
- Se agrega nota especial al prompt: "DARK FABRIC HANDLING"
- Instruye a Gemini: mantener color true black, patron apenas visible
- El swatch original se envia sin modificar a Gemini

## Patrones que FUNCIONAN

- Color solido -> Gemini cambia color correctamente en 90%+ de los casos
- Fundas de almohada -> patron se cambia bien (superficie mas plana)
- Texto/iconos en hero -> se preservan correctamente
- Composicion con modelo humana -> se mantiene bien
- Dark swatch con prompt-only -> negro verdadero, no gris
- Mismo patron hero/swatch, diferente color -> edit mode funciona perfecto

## Patrones que FALLAN (limitaciones conocidas)

### Quilting stitch pattern 3D profundo (patron diferente hero vs swatch)
- **Problema**: Gemini trata texturas 3D embossed como geometria fisica, no como patron reemplazable
- **Evidencia**: 8+ pruebas con distintos prompts, temperaturas, preprocesamiento — TODAS fallaron
- **Donde funciona**: En fundas (superficie plana) SI cambia el patron
- **Donde falla**: En el cuerpo del quilt con textura 3D profunda y drapeada
- **Solucion**: Usar Tier 2 directamente — NUNCA edit mode cuando patron ≠
- **Status**: Limitacion confirmada de Gemini. No es un problema de prompt.

### Swatch es foto lifestyle completa
- **Problema**: Si Image 2 es una foto de dormitorio (no closeup de tela), Gemini puede copiar la escena
- **Solucion aplicada**: `cropSwatchToFabric()` extrae solo la zona de tela
- **Status**: Resuelto

## Sistema de Tiers para Quilts (IMPLEMENTADO — 2026-03-06)

### Decision de Tier: BASADA EN FIDELIDAD AL PRODUCTO

```
Analizar swatch → Determinar patron del swatch
Analizar hero   → Determinar patron del hero

Si patron_swatch ≠ patron_hero:
  → Tier 2 DIRECTO (edit mode SIEMPRE inventa producto)

Si patron_swatch = patron_hero (solo cambia color):
  → Tier 1 (edit mode funciona perfecto para cambio de color)
```

### Tier 1: Edit Mode con Preprocesamiento
**SOLO usar cuando el patron del swatch = patron del hero (cambio de color unicamente)**

1. **Swatch Crop**: `cropSwatchToFabric()` en `image-processing.ts`
   - Extrae zona central de tela: y 40%-75%, x 10%-90%
   - Resize a 800x800 (Gemini prefiere cuadrado)
   - Evita muebles, fondo, cabecera
2. **Hero Flatten**: `flattenHeroEmboss()` en `image-processing.ts`
   - Lift darks: linear(0.843, 40) — mapea 0->40
   - Gaussian blur 1.5 — suaviza bordes embossed
   - Reducir contraste: linear(0.75, 32)
3. Enviar hero flatten + swatch crop como 2 imagenes + `buildPrompt()`
4. `prompt_metadata = { strategy: 'tier1_preprocess' }`

### Tier 2: Generacion desde Cero
**OBLIGATORIO cuando el patron del swatch ≠ patron del hero**
**Tambien se activa como retry cuando Tier 1 falla**

1. **Swatch Crop**: Igual que Tier 1
2. **Sin hero**: NO se envia hero — Gemini genera la escena completa
3. Prompt: `buildGenerationPrompt()` en `generate/route.ts`
   - Describe composicion textualmente segun shot_type (lifestyle, detail, main, etc.)
   - Le dice a Gemini que copie color + patron de la imagen proporcionada
4. Temperatura: **0.4** (un poco mas creativo para generar escena)
5. `prompt_metadata = { strategy: 'tier2_from_scratch' }`

**Resultado**: Producto 100% fiel al swatch. Composicion generada (no identica al hero, pero comercialmente equivalente).

### Flujo automatico actual
```
Job quilt nuevo -> Tier 1 (batch / process-next)
  -> Si aprobado: FIN
  -> Si flagged y regenerado: Tier 2 (results/[jobId]/route.ts detecta tier1 previo)
     -> Genera desde cero con swatch crop + texto
```

### Flujo IDEAL (por implementar)
```
Job quilt nuevo:
  1. Analizar swatch (patron)
  2. Analizar hero (patron)
  3. Si patron ≠ → Tier 2 DIRECTO
  4. Si patron = → Tier 1
  5. QA verifica fidelidad al swatch
```

### Metadata
Se guarda en `generation_jobs.prompt_metadata` (JSONB):
- `{ strategy: 'tier1_preprocess', crop: true, flatten: true }`
- `{ strategy: 'tier2_from_scratch' }`

### Archivos clave
- `src/lib/image-processing.ts` — `cropSwatchToFabric()`, `flattenHeroEmboss()`, `needsQuiltPreprocessing()`
- `src/lib/gemini/client.ts` — Hero es opcional (soporta 1 o 2 imagenes)
- `src/app/api/projects/[id]/generate/route.ts` — `buildGenerationPrompt()` + `buildPrompt()`
- `src/app/api/batches/[batchId]/process-next/route.ts` — Tier 1 automatico
- `src/app/api/projects/[id]/results/[jobId]/route.ts` — Tier 1/Tier 2 segun metadata previa

## QA: Verificacion de Fidelidad al Producto

El QA reviewer DEBE verificar:
1. **Patron correcto**: ¿El patron en la imagen generada coincide con el swatch? Si NO → FLAGGED por invencion de producto
2. **Color correcto**: ¿El color coincide con el swatch? Si NO → FLAGGED
3. **Distribucion correcta**: Si el swatch tiene patron solo en bordes, ¿la imagen respeta eso? Si NO → FLAGGED
4. **No hay contaminacion del hero**: ¿Hay elementos del patron del hero filtrandose? Si SI → FLAGGED

Score de penalizacion por invencion de producto: **-0.5 automatico** (garantiza que caiga bajo 0.6 = flagged)

## ANTI-PATRONES (NO hacer)

1. **3 imagenes**: Enviar Image 3 (swatch enhanced) NO funciona — Gemini ignora la 3ra imagen
2. **CLAHE como Image 2**: Reemplazar swatch con version grayscale enhanced genera colores incorrectos
3. **Temperatura alta en edit mode**: Subir de 0.2 aumenta creatividad = mas inventos = peor fidelidad
4. **Duplicar buildPrompt()**: Ya existe en Inngest (deprecated). NUNCA crear otra copia
5. **Prompt generico**: Sin category rules, Gemini no sabe que cambiar
6. **Flatten del swatch**: NUNCA aplanar el swatch — solo el hero
7. **Edit mode cuando patron ≠**: NUNCA usar edit mode cuando el swatch tiene patron diferente al hero — SIEMPRE produce invencion de producto
8. **Priorizar modelo sobre producto**: NUNCA sacrificar fidelidad al swatch por mantener la modelo/composicion del hero

## Pruebas Realizadas (2026-03-06/07)

### Edit mode con hero mandala + swatch basket weave: 8 pruebas, TODAS fallaron
| Prueba | Prompt | Temp | Resultado |
|--------|--------|------|-----------|
| A | Ultra-minimal (4 lineas) | 0.2 | Mandala persiste |
| B | Descriptivo (explica que cambiar) | 0.2 | Mandala persiste |
| C | Negativo ("REMOVE mandala") | 0.2 | Mandala persiste |
| D | "Paint over" | 0.6 | Mandala persiste (ligeramente menos) |
| E | Segmentacion por regiones | 0.3 | Mandala persiste |
| F | 1 oracion simple | 0.2 | Mandala persiste |
| G | Mas corto posible | 0.2 | Mandala persiste + cambio escena |
| H | "Swap fabric" | 0.2 | Mandala persiste |

### Enfoque invertido (Tier2 como base + agregar modelo): 2 pruebas
| Prueba | Resultado |
|--------|-----------|
| I | Modelo agregada OK, pero mandala se filtra ~40% |
| J | Idem, mandala se filtra ~40% |

**Conclusion**: Para patron ≠, SOLO Tier 2 produce fidelidad 100% al swatch.

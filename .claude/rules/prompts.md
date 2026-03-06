# Convenciones de Prompt — BANVA Image Generation

## Arquitectura del Prompt

Cada prompt tiene 3 capas:
1. **Intro + Image descriptions** — Contexto de Image 1 (hero) e Image 2 (swatch)
2. **RULE #1: Composition Lock** — Preservar composicion del hero (HIGHEST PRIORITY)
3. **RULE #2: Category-specific** — Que cambiar segun tipo de producto
4. **RULE #3: Pattern Fidelity** — Copiar patron/color exacto del swatch
5. **Final Check** — Verificacion antes de output

## Single Source of Truth

`buildPrompt()` en `src/app/api/projects/[id]/generate/route.ts`
Parametros: `(category, swatchName, colorDescription, shotType, isDarkSwatch)`
Temperatura: **0.2** (determinista, NO subir)
Resolucion: 1024x1024

## Categorias con Reglas Especializadas

### QUILTS
- Producto: quilt (cobertor liviano) + fundas de almohada
- **CRITICO**: Cambiar TANTO color COMO patron de quilting (stitch embossed)
- Si el hero tiene mandala y el swatch tiene basket weave -> output DEBE ser basket weave
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

## Patrones que FALLAN (limitaciones conocidas)

### Quilting stitch pattern 3D profundo
- **Problema**: Cuando el hero tiene textura de quilting MUY marcada (mandala, medallion), Gemini cambia el color pero mantiene el patron 3D del hero
- **Donde funciona**: En fundas (superficie plana) SI cambia el patron
- **Donde falla**: En el cuerpo del quilt con textura 3D profunda
- **Mitigacion**: Prompt enfatiza cambio de stitch pattern, pero es limitacion del modelo
- **Status**: Limitacion conocida de Gemini con texturas embossed

### Swatch es foto lifestyle completa
- **Problema**: Si Image 2 es una foto de dormitorio (no closeup de tela), Gemini puede copiar la escena
- **Solucion aplicada**: Prompt advierte explicitamente que Image 2 puede ser foto completa
- **Status**: Resuelto para composicion (ya no copia escena), parcial para patron

## ANTI-PATRONES (NO hacer)

1. **3 imagenes**: Enviar Image 3 (swatch enhanced) NO funciona — Gemini ignora la 3ra imagen
2. **CLAHE como Image 2**: Reemplazar swatch con version grayscale enhanced genera colores incorrectos
3. **Temperatura alta**: Subir de 0.2 aumenta creatividad = mas inventos = peor fidelidad
4. **Duplicar buildPrompt()**: Ya existe en Inngest (deprecated). NUNCA crear otra copia
5. **Prompt generico**: Sin category rules, Gemini no sabe que cambiar (fundas vs sabana bajera)

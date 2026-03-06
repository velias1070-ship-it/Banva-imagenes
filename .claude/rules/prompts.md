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

## Tecnica: Swatch Recortado (NUEVO — validado 2026-03-06)

**Cuando usar**: El swatch es una foto lifestyle completa (dormitorio, muebles) y Gemini no reemplaza el patron quilting del hero.

**Como hacerlo**:
1. Cargar el swatch con PIL/Sharp
2. Identificar la zona de tela del quilt (evitar bordes, muebles, fondo)
3. Crop del area de tela: aproximadamente y:480-860 para fotos landscape de cama
4. Resize a cuadrado 800x800 (Gemini prefiere cuadrado)
5. Usar el crop como Image 2 en vez del swatch original

**Resultado validado**:
- Heroes con quilt arrugado/doblado (mujer durmiendo): FUNCIONO — mandala → basket weave
- Heroes con close-up de tela (detail shot): FUNCIONO perfectamente
- Heroes con mandala plana extendida (mujer leyendo): NO FUNCIONA solo con crop — requiere flatten del hero

**Implementacion futura**: Automatizar el crop del swatch si la imagen tiene >40% de pixels no-tela (detectado por varianza de color alta que indica muebles/fondo).

## Tecnica: Flatten del Hero (NUEVO — validado 2026-03-06)

**Cuando usar**: El hero tiene un patron de quilting 3D muy prominente en superficie PLANA (mandala extendida, medallion) que el crop de swatch solo no logra reemplazar.

**Por que funciona**: La mandala embossed tiene canales de sombra profundos que Gemini interpreta como geometria fisica del objeto. Al aplanar esas sombras digitalmente, el modelo ya no "lee" la mandala como estructura fija y puede aplicar el basket weave.

**Como hacerlo** (PIL/Python):
```python
def flatten_emboss(img_bytes, max_size=1200):
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = img.size
    if max(w, h) > max_size:
        ratio = max_size / max(w, h)
        img = img.resize((int(w*ratio), int(h*ratio)), Image.LANCZOS)
    # Lift darks: map 0->40, 255->255 (reduce shadow depth in embossed channels)
    img_lifted = img.point(lambda p: int(p * 0.843 + 40))
    # Light blur to soften embossed edge transitions
    img_blurred = img_lifted.filter(ImageFilter.GaussianBlur(radius=1.5))
    # Reduce contrast to bring highlights/shadows closer
    img_flat = ImageEnhance.Contrast(img_blurred).enhance(0.75)
    buf = io.BytesIO()
    img_flat.save(buf, "PNG")
    return buf.getvalue()
```

**Resultado validado**:
- Hero "mujer leyendo" con mandala plana extendida: FUNCIONO — basket weave visible en todo el quilt body
- Usar temperatura 0.4 (no 0.2) para este caso
- Usar SIEMPRE combinado con el swatch recortado (crop de la tela)

**IMPORTANTE**: Solo modificar el HERO (Image 1). Nunca el swatch. El resultado de Gemini tiene textura correcta y calidad normal — el flatten es solo para la entrada.

## ANTI-PATRONES (NO hacer)

1. **3 imagenes**: Enviar Image 3 (swatch enhanced) NO funciona — Gemini ignora la 3ra imagen
2. **CLAHE como Image 2**: Reemplazar swatch con version grayscale enhanced genera colores incorrectos
3. **Temperatura alta**: Subir de 0.2 aumenta creatividad = mas inventos = peor fidelidad
4. **Duplicar buildPrompt()**: Ya existe en Inngest (deprecated). NUNCA crear otra copia
5. **Prompt generico**: Sin category rules, Gemini no sabe que cambiar (fundas vs sabana bajera)

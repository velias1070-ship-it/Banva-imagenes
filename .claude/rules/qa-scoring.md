# QA Scoring — Criterios y Umbrales

## Umbrales de Decision

| Score | Decision | Accion |
|-------|----------|--------|
| >= 0.80 | AUTO-APPROVE | Mover a approved, listo para descarga |
| 0.60 - 0.79 | RETRY | Regenerar con prompt ajustado (max 2 intentos) |
| < 0.60 | FLAGGED | Revision humana obligatoria |

**Halt Rule**: Si >20% del batch es flagged -> DETENER batch y reportar al usuario.

## Scoring Weights

```
score_final = (
    product_fidelity    x 0.30    <- BLOCKER: si falla, FLAGGED directo
    color_accuracy      x 0.20
    composition_match   x 0.20
    visual_quality      x 0.15
    resolution          x 0.05
    aspect_ratio        x 0.05
    ml_compliance       x 0.05
)
```

## Check 0: Fidelidad al Producto (BLOCKER)

Se ejecuta PRIMERO. Si falla cualquiera -> FLAGGED inmediato sin calcular score.

1. **Diseno correcto**: Patron/diseno corresponde al swatch asignado
2. **Distribucion del patron**: Patron se aplica donde corresponde (bordes vs all-over)
3. **Paleta de colores fiel**: Colores coinciden con swatch (no saturados, no shifted)
4. **No elementos inventados**: Sin patrones, bordados o texturas que no estan en el swatch
5. **Tipo de producto correcto**: Mismo producto que el hero (quilt no se convierte en sabana)

## Checks Tecnicos

- Resolucion: >= 1024x1024
- Tamano archivo: 100KB - 5MB (< 100KB = corrupta)
- Aspect ratio: tolerancia 0.05 de 1:1
- Formato: JPG/PNG valido

## Color Accuracy

| Distancia Euclidiana RGB | Score |
|--------------------------|-------|
| < 60 | Excelente (1.0) |
| 60-80 | Bueno (0.8) |
| 80-100 | Aceptable (0.6) |
| 100-120 | Pobre (0.3) |
| > 120 | Fallo |

## Fallos Comunes Documentados

### 1. Color shift / desaturacion
- **Sintoma**: Azul marino sale celeste, coral sale rosa palido
- **Causa**: Gemini desatura colores oscuros o vibrantes
- **Retry prompt**: "vibrant [color], rich saturated tone matching swatch exactly"
- **Frecuencia**: ~15% de imagenes con colores oscuros

### 2. Composicion copiada del swatch
- **Sintoma**: Output muestra la escena del swatch (dormitorio) en vez del hero (close-up)
- **Causa**: Swatch es foto lifestyle completa, Gemini copia la escena
- **Solucion**: Prompt reforzado — "Image 2 may be FULL PRODUCT PHOTO, extract ONLY fabric"
- **Status**: Resuelto en prompt actual

### 3. Patron inventado (arabesque/mandala)
- **Sintoma**: Gemini genera patron tipo arabesque que no existe en el swatch
- **Causa**: No interpreta bien el swatch (especialmente oscuros)
- **Solucion**: Dark swatch handling + prompt enfatico sobre pattern fidelity
- **Status**: Resuelto para la mayoria, persiste en quilting 3D profundo

### 4. Textura 3D embossed no reemplazada
- **Sintoma**: Color cambia correctamente pero patron de quilting del hero se mantiene
- **Causa**: Gemini no puede reemplazar texturas 3D muy marcadas (mandala -> basket weave)
- **Donde funciona**: Fundas de almohada (superficie plana)
- **Donde falla**: Cuerpo del quilt con textura profunda
- **Status**: Limitacion conocida del modelo — documentada, sin solucion tecnica por ahora

### 5. Fondo no blanco en tomas "main"
- **Sintoma**: Fondo grisaceo en vez de blanco puro
- **Retry prompt**: "Pure white background #FFFFFF. No gray tones."
- **Frecuencia**: ~10% de tomas tipo "main"

## Casos Dificiles

### Dark-on-dark (Borgona, Chocolate, Azul Marino, Negro)
- Contraste bajo entre producto y entorno
- Usar: "Ensure strong contrast. Dark fabric edges clearly defined with subtle rim lighting."
- Dark swatch threshold: brightness < 115

### Light-on-white (Blanco, Arena, Crema, Marfil)
- Producto se pierde contra fondo blanco
- Usar: "Add subtle soft shadow beneath product to separate from white background."

### Patrones parciales (flores en bordes, cenefas)
- Gemini tiende a aplicar patron all-over cuando deberia ser solo en bordes
- Usar: "Pattern appears ONLY on [ubicacion]. Rest of fabric is [color liso]."

## MercadoLibre Compliance

Para imagen principal:
- Fondo blanco puro (RGB > 240 en esquinas)
- Sin texto ni watermarks generados por IA
- Producto centrado y prominente
- Minimo recomendado: 1200px
- Formato: JPG, max 2MB

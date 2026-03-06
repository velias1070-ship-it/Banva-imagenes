# Sistema de Aprendizaje por Feedback

## Problema
Vicente es el QA real. El QA automatico aprueba imagenes que Vicente despues rechaza.
Ese feedback se pierde al terminar la sesion y el mismo error se repite en el proximo batch.

## Ciclo Actual (no escala)
```
Gemini genera -> QA auto aprueba (0.82) -> Vicente rechaza ("color mal")
-> Se corrige manualmente -> Sesion termina -> Aprendizaje PERDIDO
-> Proximo batch: mismo error se repite
```

## Ciclo Objetivo (escala y mejora solo)
```
Gemini genera -> QA evalua con criterios ACUMULADOS
-> Si aprueba: Vicente spot-check 10-20%
-> Si Vicente rechaza: feedback se ESTRUCTURA y GUARDA
-> Rules de categoria se actualizan
-> Criterios de QA se hacen mas estrictos
-> Proximo batch: error ya se detecta automaticamente
-> Con el tiempo: Vicente revisa cada vez menos
```

## 1. Taxonomia de Errores

Codigos que cubren el 90% de los rechazos:

| Codigo | Categoria | Ejemplo |
|--------|-----------|---------|
| COLOR | Color incorrecto o desaturado | "Pedi azul marino, salio celeste" |
| TEXTURA | Material no se ve real | "El algodon parece plastico" |
| FORMA | Producto deformado | "El quilt parece una servilleta" |
| FONDO | Fondo incorrecto | "Fondo con elementos que no pedi" |
| SOMBRA | Iluminacion irreal | "Sombra inconsistente, parece flotando" |
| COMPOSICION | Encuadre incorrecto | "Deberia estar doblado, no extendido" |
| BRANDING | No coincide con estetica BANVA | "Parece producto de lujo, BANVA es accesible" |
| ARTEFACTO | Glitch visual de la IA | "Dedos extra, texto ilegible, bordes fundidos" |
| PATRON | Patron de tela incorrecto | "Quilting mandala pero swatch es basket weave" |

## 2. Formato de Captura de Feedback

Cada rechazo genera un registro estructurado:

```json
{
  "job_id": "af8c704e-...",
  "project_id": "60632d7f-...",
  "swatch_name": "Lila Basket Weave",
  "category": "quilts",
  "hero_shot_type": "lifestyle",
  "error_codes": ["PATRON", "TEXTURA"],
  "description": "Color correcto pero quilting mandala del hero persiste en vez del basket weave del swatch",
  "prompt_used": "...",
  "correction_applied": "Enfatizar en RULE #2 que stitch pattern DEBE cambiar",
  "was_regenerated": true,
  "regeneration_success": false,
  "date": "2026-03-06",
  "resolution": "Limitacion conocida de Gemini con texturas 3D profundas"
}
```

### Donde almacenar (opciones por fase)
- **Fase 1 (ahora)**: Tabla `image_feedback` en Supabase o archivo JSON en repo
- **Fase 2**: Dashboard en la app con UI de rechazo + codigos
- **Fase 3**: Automatico — el sistema detecta patrones y propone cambios

## 3. De Feedback a Regla: Proceso de Aprendizaje

### Paso 1: Detectar patrones
Un agente "Curator" (Sonnet) lee feedback reciente y busca:
- Errores repetidos en misma categoria -> Regla de categoria
- Errores repetidos con mismo color -> Regla de color
- Errores repetidos con Gemini -> Regla tecnica

### Paso 2: Proponer actualizacion
El Curator genera un diff propuesto:

```markdown
## Cambio propuesto para prompts.md

### Agregar a "Patrones que FALLAN":
- quilts con stitch pattern 3D profundo: Gemini mantiene patron del hero
  Evidencia: 3 rechazos en batch "Quilt roma 2", jobs af8c704e, 63003eda, 9c32c91c

### Agregar a qa-scoring.md "Fallos comunes":
- NUEVO CHECK: En quilts, verificar que stitch pattern del OUTPUT
  coincida con swatch, no con hero
```

### Paso 3: Vicente aprueba o ajusta
- El Curator NUNCA modifica rules automaticamente
- Vicente revisa, aprueba, y se commitea el cambio
- Con confianza acumulada: auto-commit para cambios menores

## 4. QA Checks Dinamicos por Categoria

Los checks CRECEN con el tiempo. Ejemplo para quilts:

```markdown
# QA Checks — Quilts (v3, actualizado 2026-03-06)

## Checks universales:
- [ ] Producto es foco principal (>60% del frame)
- [ ] Fondo limpio
- [ ] Sin artefactos visuales
- [ ] Resolucion suficiente

## Checks especificos quilts (aprendidos):
- [ ] Textura visible de acolchado/stitching
- [ ] Stitch pattern coincide con SWATCH (no con hero)
- [ ] Si es azul: verificar saturacion no inferior a referencia
- [ ] Producto muestra volumen/pliegues naturales
- [ ] Fundas de almohada tienen MISMO patron que quilt body

## Checks agregados v3:
- [ ] Si swatch es foto lifestyle: verificar que composicion sea del HERO
- [ ] Dark swatches: color debe ser true black (no gris)
```

## 5. Metricas de Mejora

| Metrica | Como se mide | Meta 3 meses |
|---------|-------------|--------------|
| Aprobacion primer intento | Aprobadas sin retry / total | 60% -> 85% |
| Retries promedio | Generaciones / imagenes finales | 1.5 -> 1.15 |
| Tasa de override Vicente | QA aprueba pero Vicente rechaza / spot-checked | 40% -> 10% |
| Costo por imagen aprobada | Costo total / aprobadas finales | <$0.05 |
| Cobertura de checks | Rechazos con check existente / total rechazos | ->90% |

**Metrica clave**: "Tasa de override" — cuando baje a <5%, el pipeline puede operar en produccion sin supervision constante.

## 6. Fases de Implementacion

### Fase 1 — AHORA (esta sesion)
- Documentar taxonomia de errores (esta en este archivo)
- Los rechazos manuales en la app ya generan datos (status "flagged" en generation_jobs)
- Reglas aprendidas se documentan en `prompts.md` y `qa-scoring.md` manualmente

### Fase 2 — Semana 1-2
- Agregar UI de rechazo con codigos de error en la pagina de resultados
- Tabla `image_feedback` en Supabase para almacenar feedback estructurado
- QA adversarial (ver `agents.md` seccion "Evolucion Futura")

### Fase 3 — Mes 1
- Agente Curator que lee feedback y propone cambios a rules
- Dashboard de metricas
- Expandir checks a todas las categorias

### Fase 4 — Mes 2-3
- Auto-commit del Curator para cambios menores
- Vicente solo spot-check 10-20%
- Pipeline en produccion autonoma

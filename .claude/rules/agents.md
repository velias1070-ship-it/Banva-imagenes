# Arquitectura de Subagentes — BANVA Pipeline

## Arquitectura General

```
Orchestrator (Claude Sonnet/Opus)
    |
    +-- prompt-builder (Haiku) -- Construye prompts
    +-- image-generator (Haiku) -- Ejecuta Gemini API calls
    +-- qa-reviewer (Sonnet) -- Evalua calidad visualmente
    +-- researcher (Sonnet) -- Investiga tendencias (on-demand)
```

## Detalle por Agente

### 1. prompt-builder (Haiku)
- **Rol**: Construye prompts optimizados para Gemini
- **Modelo**: claude-haiku-4-5 (barato, rapido, suficiente para text generation)
- **Input**: JSON con paths, metadata, categoria del producto
- **Output**: JSON con prompts construidos
- **Tools**: Read, Write
- **NO necesita**: Imagenes base64. Solo paths y metadata textual.

### 2. image-generator (Haiku)
- **Rol**: Ejecuta llamadas a la API de Gemini
- **Modelo**: claude-haiku-4-5 (solo orquesta curl calls, no necesita razonamiento complejo)
- **Input**: Prompts pre-construidos + paths a imagenes
- **Output**: Imagenes generadas guardadas en disco/storage
- **Tools**: Bash (curl, base64, python3, sleep, jq), Read, Write
- **Carga base64**: Solo en memoria para el API call, NO en el prompt de Claude
- **Rate limit**: 7 segundos entre requests, max 9 RPM

### 3. qa-reviewer (Sonnet)
- **Rol**: Evalua calidad de imagenes generadas
- **Modelo**: claude-sonnet-4-5 (necesita vision + razonamiento complejo)
- **Input**: Imagenes generadas + hero shots + swatches originales
- **Output**: QA report JSON con scores y decisiones
- **Tools**: Bash (python3, identify, convert, stat, find, mv, mkdir, ls), Read, Write
- **SI necesita imagenes**: UNICO agente que debe VER las imagenes (Read tool) para comparar visualmente
- **Checks**: Fidelidad al producto (BLOCKER), color accuracy, composicion, calidad visual

### 4. researcher (Sonnet)
- **Rol**: Investiga tendencias de imagenes en MercadoLibre
- **Modelo**: claude-sonnet-4-5 (necesita busqueda web + analisis)
- **Input**: Categoria de producto, tasa de aprobacion reciente
- **Output**: Recomendaciones de estilo (max 2000 tokens)
- **Tools**: WebSearch, Read, Write
- **NO necesita imagenes**: Solo trabaja con texto y web search
- **Invocacion**: Solo bajo demanda explicita del usuario

## REGLA CRITICA: Optimizacion de Contexto

### El problema
Cada imagen base64 (~1-2MB) consume ~5,000-8,000 tokens de contexto.
Si un batch tiene 10 swatches, son 50K-80K tokens SOLO en imagenes.
Pasar imagenes a agentes que no las necesitan es un desperdicio masivo.

### Regla: Solo pasar base64 a quien lo necesita

| Agente | Necesita base64? | Que recibe |
|--------|-----------------|------------|
| prompt-builder | NO | Paths, metadata, categoria |
| image-generator | Solo para API call | Paths (carga base64 en memoria para curl) |
| qa-reviewer | SI | Lee imagenes con Read tool |
| researcher | NO | Solo texto |

### Calculos de ahorro
- Sin optimizar: 4 agentes x 10 imagenes x 7K tokens = 280K tokens/batch
- Optimizado: 1 agente x 10 imagenes x 7K tokens = 70K tokens/batch
- **Ahorro: 75% de tokens de imagen** (210K tokens por batch)

## BUG CONOCIDO: Inngest Duplicate

`src/lib/inngest/functions/batch-generate.ts` contiene un `buildPrompt()` DUPLICADO:
- NO tiene dark swatch handling
- NO tiene category-specific rules (quilts, sabanas)
- NO tiene las mejoras de prompt recientes
- **Status**: DEPRECATED — el flujo actual usa serverless chain (`process-next`), no Inngest
- **Accion**: No borrar (puede servir de referencia), pero NUNCA usar para generacion real

## Evolucion Futura — QA Adversarial

### Patron: Dos Reviewers + Arbitro

El QA actual usa un solo reviewer. Para mejorar precision, implementar:

```
Imagen generada
    |
    +-- Reviewer A (Sonnet) -- Evalua con enfoque en fidelidad de producto
    +-- Reviewer B (Sonnet) -- Evalua con enfoque en calidad visual/comercial
    |
    +-- Arbitro (Sonnet/Opus) -- Solo interviene si A y B no coinciden
```

### Como funciona
1. **Reviewer A** (Fidelidad): Se enfoca en comparar patron, color, distribucion vs swatch original. Es estricto con la fidelidad al producto.
2. **Reviewer B** (Comercial): Se enfoca en calidad fotografica, naturalidad, potencial de venta en MercadoLibre. Mas enfocado en "se ve bien para un comprador?"
3. **Si ambos aprueban** -> Auto-approve (alta confianza)
4. **Si ambos rechazan** -> Auto-reject (alta confianza)
5. **Si no coinciden** -> Arbitro evalua con mas contexto y decide

### Ventajas
- Reduce falsos positivos (imagenes que parecen bien pero tienen errores sutiles de fidelidad)
- Reduce falsos negativos (imagenes fieles pero que el usuario rechazaria por aspecto)
- El Arbitro solo se invoca en ~15-20% de los casos (ahorro de tokens)

### Cuando implementar
- Cuando la tasa de override de Vicente sea >15% (el QA actual aprueba pero Vicente rechaza)
- Estimado: Mes 2-3 del pipeline en produccion
- Costo adicional: ~30% mas tokens de QA (2 reviewers vs 1), pero compensado por menos retries humanos

### Configuracion sugerida
```json
{
  "qa_mode": "adversarial",
  "reviewer_a": { "model": "sonnet", "focus": "product_fidelity", "weight": 0.6 },
  "reviewer_b": { "model": "sonnet", "focus": "commercial_quality", "weight": 0.4 },
  "arbiter": { "model": "opus", "trigger": "disagreement", "threshold": 0.15 },
  "auto_approve": { "both_agree": true, "min_combined_score": 0.82 },
  "auto_reject": { "both_reject": true, "max_combined_score": 0.55 }
}
```

### Prerequisitos
1. Tener `feedback-loop.md` implementado (datos de rechazos de Vicente)
2. Minimo 50 imagenes evaluadas por Vicente para calibrar
3. Definir los checks especificos por categoria (ver `qa-scoring.md`)

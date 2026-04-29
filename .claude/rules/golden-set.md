# Golden Set — Sistema de benchmarking de modelos

Sprint 3 introdujo un CLI flexible para benchmarking de modelos contra casos
reales de prod, persistido en la tabla `golden_runs`. La idea: cuando salga
un modelo nuevo, no adoptarlo a routing-rules.json a ciegas — primero
correrlo contra una suite, comparar contra el modelo actual, y decidir.

## Comandos

```
npm run golden -- --suite <name>   --model <model_id> [--dry] [--yes]
npm run golden -- --filter <expr>  --model <model_id> --limit N [--dry]
npm run golden -- --jobs "id1,id2" --model <model_id> [--dry]

npm run golden:compare -- --base <run_id> --against <run_id> [--persist]
```

Modelos disponibles: lo que esté en `MODEL_REGISTRY` (ver `src/lib/models/registry.ts`).
Suites disponibles: archivos `.yaml` en `benchmarks/suites/`.

`<expr>` es un query string PostgREST (e.g. `category=eq.alfombras&status=eq.approved`).
`--jobs` acepta UUIDs separados por coma.

## Suites incluidas

- **`critical-cases.yaml`** — 7 casos históricos de feedback (sabanas multipattern,
  quilt stripes side-angle, toalla swatch full-product-photo, cubrecama
  pattern_replacement, toalla blanco/claro, multi-surface stripe,
  alfombras printed_illustration). Cada uno tiene un `discovery_filter`
  que el runner resuelve a un job real al momento de correr.
- **`alfombras-debugging.yaml`** — 5 case_signatures de alfombras donde
  model_performance MV mostró 0% approval. Para investigar si un modelo
  distinto al actual mejora la tasa.
- **`full-coverage.yaml`** — 1 caso por categoría activa en
  `category-strategy.ts`. Smoke test amplio para detectar regresiones que
  solo aparecen en una categoría.

## Workflow típico — adoptar un modelo nuevo

```
1. Agregar entry a src/lib/models/registry.ts y src/lib/providers/<id>.ts
2. Establecer baseline (modelo actual de producción):
     npm run golden -- --suite critical-cases --model gemini-flash
   → anota run_id_base
3. Correr contra el candidato:
     npm run golden -- --suite critical-cases --model <nuevo>
   → anota run_id_against
4. Comparar:
     npm run golden:compare -- --base <run_id_base> --against <run_id_against>
5. Si dice ADOPT → editar routing-rules.json, mergear, deployar
   Si dice DO_NOT_ADOPT → cerrar PR del modelo nuevo
   Si dice PARTIAL → adoptarlo solo en categorías específicas via
                     swatch_overrides / category attempts en routing-rules
```

## Persistencia

`golden_runs` schema:
- `run_id` UUID — agrupa todas las filas de una sola invocación CLI
- `case_id` TEXT — id del caso de la suite, o el job_id para modos 2/3
- `model_id_tested` TEXT — el modelo que se forzó (vía `forcedModelId`)
- `score_total`, `score_per_dim`, `cost_usd`, `duration_ms`, `output_path`
- `compared_to_run_id` — para filas de seguimiento de un compare-runs
- `run_metadata` JSONB — snapshot de metadata (versión de suite, error, etc.)

## Forzar modelo en runtime — `forcedModelId`

`generateImageSmart()` acepta `ctx.forcedModelId` opcional. Cuando está,
salta routing-rules y la cadena de fallback a GPT-2. Solo para benchmarks —
producción nunca debe pasarlo. Comentario en JSDoc del param. Routing
decisions belong in routing-rules.json, not in callers.

## Scoring

La primera versión del CLI usa scoring placeholder (1.0 si la generación
exitosa, 0.0 si falla). El scoring real (verifier 2.5 Pro) es follow-up
explícito — el primer iteración prioriza el schema + run loop + comparator.

## Lo que NO entra en Sprint 3

- UI web en BANVA Bodega (Sprint 4 si se decide)
- Auto-trigger por cron (manual por ahora)
- Integración CI/CD (sprint futuro)

# benchmarks/

Sistema de benchmarking de modelos generativos para BANVA.

## Estructura

```
benchmarks/
├── README.md                       este archivo
└── suites/
    ├── critical-cases.yaml         7 casos históricos de feedback
    ├── alfombras-debugging.yaml    5 case_signatures de alfombras 0% approval
    └── full-coverage.yaml          1 caso por categoría activa
```

## Cómo correr

```
npm run golden -- --suite critical-cases --model gemini-flash
npm run golden -- --filter 'category=eq.alfombras&status=eq.approved' --limit 5 --model gemini-pro
npm run golden -- --jobs "uuid1,uuid2" --model gpt-image-2

npm run golden:compare -- --base <run_id_base> --against <run_id_against>
```

Documentación completa en `.claude/rules/golden-set.md`.

## Schema de una suite

```yaml
suite: <slug-name>
description: |
  Texto multi-línea explicando para qué sirve.
version: 1
default_min_score: 0.70   # opcional, default 0.70

cases:
  - id: <case-slug>
    description: ...
    discovery_filter:
      # cualquier subset de:
      category: quilts                      # categoría exacta
      category_in: [cubrecama, cubrecamas]  # alternativa OR
      case_signature: "alfombras:detail:multipattern:light"  # match exacto
      case_signature_like: "%multipattern%" # match LIKE
      status_in: [approved, flagged]        # filtro de status
    expected_min_score: 0.75                # opcional, override del default
```

## Agregar una suite nueva

1. Crear `benchmarks/suites/<nombre>.yaml` con el schema arriba.
2. Cada `case` necesita un `discovery_filter` que matchee al menos un
   `generation_jobs` row con `hero_shot_id` y `swatch_id` no nulos en prod.
3. Validar parseando: `npx tsx scripts/test-golden-runner-mock.ts` (corre
   sobre todas las suites de `benchmarks/suites/*.yaml`).
4. Smoke test: `npm run golden -- --suite <nombre> --model gemini-flash --dry`
   muestra qué casos resolvió sin generar.

## Convención de naming

- `critical-cases.yaml` — patrones que ya rompieron en prod
- `<feature>-debugging.yaml` — investigación puntual de un area
- `full-coverage.yaml` — un caso por categoría
- `<integration>-validation.yaml` — para validar adopción de modelo nuevo

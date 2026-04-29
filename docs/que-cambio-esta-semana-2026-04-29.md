# Qué cambió esta semana — banva-app

**Período**: 2026-04-22 → 2026-04-29
**Sprints cerrados**: 1 + 2 + 3 + 4
**Branch principal**: `main`
**Producción**: https://banva-app.vercel.app

Este documento es para Vicente. No es un changelog técnico — es un resumen
operativo de qué cambió, qué decisión podés tomar ahora que antes no podías,
y qué quedó pendiente.

---

## TL;DR

- **Multi-modelo en runtime**: Flash sigue siendo default, pero ahora hay
  routing por categoría (alfombras escala a GPT-Image-2 antes), retry
  automático en rate-limit (no se pierden jobs por 429), cost cap por
  categoría (corta cadenas de retry runaway).
- **Telemetría real**: cada job persiste qué modelo lo generó, en qué
  attempt, con qué prompt, cuánto costó. Antes no había forma de saber
  qué bucket de casos rinde mal.
- **Vista agregada `model_performance`**: rollup diario de approval rate,
  costo promedio, qa_score promedio por (modelo × case_signature × attempt).
- **Detector de regresiones**: cron cada 15min compara la mitad reciente vs.
  la mitad anterior y avisa si una combo cae >15pp.
- **Golden test set CLI**: corré una suite YAML contra cualquier modelo en
  ~30s, persiste a `golden_runs`, comparator escupe ADOPT/DO_NOT_ADOPT/PARTIAL
  con razón.
- **Admin UI** (`/admin`): editás routing-rules, lanzás benchmarks, leés
  performance — sin tocar el código.

## El primer hallazgo del sistema (importante)

Apenas la UI de `/admin/performance` quedó accesible, salió este número:

> **Alfombras: 86% error rate. 6 de 7 jobs fallaron con escalation Flash → Pro
> gastando $0.21/job sin éxito. Sangrado real ~$1.26 en alfombras sin un solo
> aprobado.**

Antes de esta semana, este dato no existía en ninguna parte. Estaba implícito
en `generation_jobs` pero nadie lo agregaba. La MV `model_performance` lo
hizo visible al primer query.

Esto es lo que justifica todo el trabajo de Sprint 1+2: sin telemetría per-modelo
y vista agregada, no hay forma de detectar que una categoría está sangrando
plata. Con el sistema actual, esto se ve en `/admin/performance` filtrando
por `signature contains alfombras`.

**Acción acordada para Sprint 5** (no arrancado, queda anotado):
1. Investigar por qué el `case_signature` queda como `:unknownpattern` en
   alfombras — el classifier no lo está clasificando.
2. A/B test golden con `gpt-image-2` como primary para alfombras.
3. Si gana, cambiar `routing-rules.json` desde `/admin/models` (commit + redeploy
   automático vía GitHub API).
4. Validación productiva durante una semana.

---

## Lo que se entregó por sprint

### Sprint 1 — Multi-modelo + telemetría
*(cerrado en sesiones previas, contexto)*

- `MODEL_REGISTRY` en `src/lib/models/registry.ts` con 4 modelos
  (gemini-flash, gemini-pro, gpt-image-2, fal-stub).
- Adapters por proveedor: `src/lib/providers/{gemini,openai,fal}.ts`.
- `generateImageSmart()` con routing-rules + fallback chain.
- `config/routing-rules.json` validado por Zod en runtime.
- Telemetría en `generation_jobs.pipeline_log` (JSONB array de events).
- Migration **007** — columnas de provider_telemetry.

### Sprint 2 — Hardening (7 issues)

| # | Qué arregla | Cómo |
|---|---|---|
| 1 | Jobs perdidos por HTTP 429 | Cron cada 10min promueve `qa_rate_limited → qa_pending` con backoff [0.5, 2, 10, 30, 60] min. Migration **008**. |
| 2 | Imposible agrupar casos similares | Helper `case_signature` con formato `category:shot_type:pattern_relation:darkness`. Backfill recuperó 53.6%. Migration **009**. |
| 3 | Cadenas de retry runaway | Cost cap por categoría — cuando se excede, status `flagged` en vez de seguir escalando. |
| 4 | Sin vista agregada de performance | Materialized view `model_performance` con refresh diario CONCURRENTLY. Migration **010**. |
| 5 | Regresiones invisibles hasta días después | Cron cada 15min con `detectRegression()` — rolling window vs. baseline, alerta a Viki webhook (stub hasta que el canal esté). |
| 6 | Drift de schema (9 columnas sin declarar) | Migration **011** las declara con `ADD IF NOT EXISTS` + comentarios. |
| 7 | Inngest deprecated path estorbando | Eliminado completo (3 archivos + dependencia). |

### Sprint 3 — Golden Set CLI

CLI flexible para benchmarking con 3 modos de input:
```
npm run golden -- --suite critical-cases     --model gemini-flash
npm run golden -- --filter 'category=eq.alfombras&status=eq.approved' --model gpt-image-2 --limit 5
npm run golden -- --jobs "uuid1,uuid2"       --model gemini-pro
npm run golden:compare -- --base <run_id> --against <run_id> [--persist]
```

- Migration **012** — tabla `golden_runs` (1 row por caso, agrupados por `run_id`).
- Migration **013** — GRANTs sobre `golden_runs` (la 012 los olvidó, primer aprendizaje).
- 3 suites YAML: `critical-cases.yaml`, `alfombras-debugging.yaml`, `full-coverage.yaml`.
- `forcedModelId` en `ProviderSelectionContext` — bypass del routing-rules para benchmarks (con guardrail JSDoc + 17 unit tests verificando que también skipea el GPT-2 fallback).
- Comparator puro (`src/lib/golden-comparator.ts`): clasifica regression/improvement/parity/missing y escupe recomendación ADOPT/DO_NOT_ADOPT/PARTIAL con razón.
- 27 tests unitarios del comparator.

#### Issue post-merge (registrado)
La v1 de `critical-cases.yaml` usaba wildcards `%multipattern%` con post-fetch filter por categoría. El `.limit(50)` PostgREST se saturaba con jobs de otras categorías antes del filter, así que 6 de 7 cases no resolvían. Fix `8aaa734`: re-poblé las suites con `case_signature` exactos (que existen en prod, validado vía `scripts/discover-case-signatures.ts`). Ahora 7/7 + 5/5 resuelven.

### Sprint 4 — Admin UI

3 páginas en `/admin/*`, gated por Supabase magic-link + `ADMIN_EMAILS` allowlist.

- **`/admin/models`** — Editor de `config/routing-rules.json`. Save valida con Zod y commitea via GitHub API; Vercel redeploya solo.
- **`/admin/benchmarks`** — Lista paginada de runs históricas, detalle por `run_id`, form para correr nuevo benchmark, comparator inline (markdown rendered).
- **`/admin/performance`** — Tabla de `model_performance` MV, sortable por cualquier columna, filtros por modelo/signature/attempt, botón "Refresh now".

Auth: `src/proxy.ts` (Next.js 16 successor a `middleware.ts`), magic-link via `/login`, callback en `/auth/callback`.

#### Issue post-merge (registrado)
La MV `model_performance` no tenía GRANT al service_role/authenticated. Fix manual aplicado por Vicente en prod 2026-04-29:
```sql
GRANT SELECT ON TABLE model_performance TO service_role;
GRANT SELECT ON TABLE model_performance TO authenticated;
GRANT SELECT ON TABLE model_performance TO anon;
```
Versionado en migration **014**.

---

## Estado de la infraestructura al cierre

### 8 migraciones aplicadas en prod este ciclo
```
007 provider_telemetry              (Sprint 1)
008 rate_limit_recovery             (Sprint 2 #1)
009 case_signature                  (Sprint 2 #2)
010 model_performance MV            (Sprint 2 #4)
011 schema_drift_documentation      (Sprint 2 #6)
012 golden_runs                     (Sprint 3)
013 golden_runs_grants              (Sprint 3 follow-up)
014 model_performance_grants        (Sprint 4 follow-up)
```

### 4 crons activos
```
/api/cron/retry-rate-limited        every 10 min   429 recovery
/api/cron/refresh-model-performance daily          REFRESH MV CONCURRENTLY
/api/cron/regression-alert          every 15 min   detectRegression + Viki stub
/api/cron/health-check              daily          defense-in-depth
```

### 7 scripts de test, 190 assertions verde
```
test-rate-limit-transitions   45  ✓
test-case-signature           35  ✓
test-cost-cap-helpers         29  ✓
test-regression-detector      23  ✓
test-golden-comparator        27  ✓
test-golden-runner-mock       17  ✓
test-admin-handlers           14  ✓  ← Sprint 4
─────────────────────────────────────
TOTAL                        190
```

---

## Cómo usar /admin (referencia rápida)

### Adoptar un modelo nuevo (workflow)
```
1. Abrir /admin/benchmarks/new
2. Seleccionar suite "critical-cases" + modelo actual (gemini-flash)
   → "Run". Anotar run_id_base.
3. Misma suite + modelo candidato. Anotar run_id_against.
4. Abrir el detalle del run candidato → "Compare with another run":
   pegar run_id_base, marcar "persist", "Compare".
5. Leer el markdown:
     - ADOPT       → editar routing en /admin/models
     - DO_NOT_ADOPT → cerrar
     - PARTIAL      → adoptar solo en categorías específicas via swatch_overrides
6. Si ADOPT: /admin/models → editar JSON → Save. Vercel auto-deploya.
```

### Ver una categoría que está sangrando
```
/admin/performance → filter "Signature contains" = alfombras → sort por approval_pct asc
```

### Refrescar la MV manualmente
```
/admin/performance → "Refresh now" (también corre diario por cron)
```

---

## Pendientes operativos

### Vercel env vars (sin estos, /admin no funciona del todo)
```
ADMIN_EMAILS=velias1070@gmail.com
GITHUB_TOKEN=<PAT con contents:write en este repo>
GITHUB_REPO=velias1070-ship-it/Banva-imagenes
GITHUB_BRANCH=main             (opcional, default 'main')
```

### Supabase Dashboard
```
Authentication → Providers → Email enabled → Magic link configurado
Authentication → URL Configuration:
  Site URL:     https://banva-app.vercel.app
  Redirect URLs: https://banva-app.vercel.app/auth/callback
```

### Backlog técnico Sprint 3 (5 TODOs registrados)
1. **Real scoring (verifier 2.5 Pro)** — el CLI usa placeholder 1.0/0.0.
2. **`fabric_profile` column gap** — referenciada cast-to-null en runtime, no existe en `swatches`.
3. **`cost_usd_actual` overwriting** — sumatorio recalcula desde pipeline_log cada vez en lugar de mantener acumulador.
4. **alfombras `unknownpattern` 0% approval** — primer hallazgo de la nueva visibilidad. Sprint 5 driver.
5. **MV per-attempt breakdown** — falta vista derivada que descomponga conversión attempt 0→1→2.

### Viki webhook
`regression-alert` route lee `VIKI_WEBHOOK_URL` + `VIKI_SECRET`. Sin esas vars, loguea pero no postea. Configurar cuando exista canal real.

---

## Próximo Sprint (anotado, NO arrancado)

**Sprint 5 — alfombras**:
- Investigar por qué `case_signature` queda `:unknownpattern` en alfombras.
- A/B test golden con `gpt-image-2` como primary para alfombras.
- Si gana, cambiar `routing-rules.json` desde la UI nueva.
- Validación productiva durante semana.

Vicente decide cuándo arrancar — yo no opino sobre timing.

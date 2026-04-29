/**
 * Case signature for telemetry — Sprint 2 issue #2.
 *
 * The model_performance materialized view (Sprint 2 issue #4) groups job
 * outcomes by (model_id, case_signature, attempt) so we can spot regressions
 * scoped to specific generation conditions, not just averages across the whole
 * batch. A signature is a colon-separated lowercase token string that
 * identifies the qualitative shape of a job from the model's perspective:
 *
 *   <category>:<shot_type>:<pattern_relation>:<darkness>[:<opacity>]
 *
 * Examples:
 *   sabanas:lifestyle:multipattern:dark
 *   quilts:main:samepattern:light
 *   cortinas:lifestyle:unknownpattern:light:sheer
 *   cubrecama:doblada:multipattern:dark:translucent
 *
 * Token rules:
 *   - lowercase, no spaces, ASCII only
 *   - 4 tokens minimum, opacity is optional and only emitted when not 'opaque'
 *   - all tokens are stable enums — never raw user strings — so the cardinality
 *     stays bounded for materialized-view aggregation
 *
 * Pure function. No side effects, no DB. Tested in
 * scripts/test-case-signature.ts ($0 to run).
 */

export type PatternRelation = 'samepattern' | 'multipattern' | 'unknownpattern';
export type Darkness = 'dark' | 'light';
export type Opacity = 'opaque' | 'translucent' | 'sheer';

export interface CaseSignatureInput {
  category: string | null | undefined;
  shotType: string | null | undefined;
  /** true if patterns differ (multipattern), false if similar, null if unknown. */
  patternsDiffer: boolean | null | undefined;
  isDarkSwatch: boolean | null | undefined;
  opacity?: Opacity | null;
}

const KNOWN_CATEGORIES = new Set([
  'sabanas', 'quilts', 'cubrecama', 'cubrecamas', 'toallas', 'cortinas',
  'almohadas', 'almohadones', 'fundas', 'mantas', 'frazadas', 'pieceras',
  'alfombras', 'plaids', 'protectores', 'colchones', 'textile', 'brand',
]);

const KNOWN_SHOT_TYPES = new Set([
  'lifestyle', 'main', 'detail', 'doblada', 'flatlay', 'infografia', 'packshot',
]);

function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const cleaned = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
  if (!cleaned) return 'unknown';
  return KNOWN_CATEGORIES.has(cleaned) ? cleaned : cleaned;
}

function normalizeShotType(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const cleaned = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
  if (!cleaned) return 'unknown';
  return KNOWN_SHOT_TYPES.has(cleaned) ? cleaned : cleaned;
}

function patternToken(patternsDiffer: boolean | null | undefined): PatternRelation {
  if (patternsDiffer === true) return 'multipattern';
  if (patternsDiffer === false) return 'samepattern';
  return 'unknownpattern';
}

function darknessToken(isDark: boolean | null | undefined): Darkness {
  return isDark === true ? 'dark' : 'light';
}

export function buildCaseSignature(input: CaseSignatureInput): string {
  const tokens = [
    normalizeCategory(input.category),
    normalizeShotType(input.shotType),
    patternToken(input.patternsDiffer),
    darknessToken(input.isDarkSwatch),
  ];

  // Opacity is only emitted when non-default. Most swatches are 'opaque', so
  // most signatures stay at 4 tokens. Sheer/translucent are the regimes where
  // model behavior diverges (Gemini Flash struggles with sheer textiles).
  if (input.opacity === 'sheer' || input.opacity === 'translucent') {
    tokens.push(input.opacity);
  }

  return tokens.join(':');
}

/**
 * Best-effort signature reconstruction from a historical job's metadata.
 * Returns null if we can't reconstruct the 4 required tokens with confidence.
 *
 * Used by scripts/backfill-case-signature.ts. The runtime path always has
 * complete data and should call buildCaseSignature() directly.
 */
export function inferCaseSignatureFromJob(job: {
  category?: string | null;
  shot_type?: string | null;
  detected_shot_type?: string | null;
  prompt_metadata?: Record<string, unknown> | null;
  pipeline_log?: Array<{ event: string; data?: Record<string, unknown> | string | null }> | null;
}): { signature: string | null; source: 'sprint_1_runtime' | 'backfill_inferred' | 'insufficient' } {
  const meta = job.prompt_metadata || {};

  // Fast path: Sprint-1 runtime jobs persist swatchProfile, dark flag, and
  // pattern_similarity in prompt_metadata. The dark flag is stored under
  // either `dark_swatch` (process-next runtime, today) or `is_dark_swatch`
  // (older results route variant) — accept both.
  const sp = meta.swatchProfile as { opacity?: Opacity } | undefined;
  const darkRaw = typeof meta.dark_swatch === 'boolean' ? meta.dark_swatch
    : typeof meta.is_dark_swatch === 'boolean' ? meta.is_dark_swatch
    : null;
  const sprint1IsDark = darkRaw as boolean | null;
  const sprint1PatternSim = typeof meta.pattern_similarity === 'boolean'
    ? meta.pattern_similarity as boolean
    : null;

  if (sprint1IsDark !== null && sprint1PatternSim !== null && (job.shot_type || job.detected_shot_type)) {
    return {
      signature: buildCaseSignature({
        category: job.category,
        shotType: job.detected_shot_type || job.shot_type,
        patternsDiffer: !sprint1PatternSim,
        isDarkSwatch: sprint1IsDark,
        opacity: sp?.opacity || null,
      }),
      source: 'sprint_1_runtime',
    };
  }

  // Slow path: scan pipeline_log for PATTERN_COMPARED + DARK_SWATCH events.
  let patternsDiffer: boolean | null = null;
  let isDark: boolean | null = null;
  for (const entry of job.pipeline_log || []) {
    if (entry.event === 'PATTERN_COMPARED') {
      const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      // Logged value is the SIMILARITY boolean, so similar=true → patternsDiffer=false.
      if (dataStr === 'true' || dataStr.includes('"true"')) patternsDiffer = false;
      else if (dataStr === 'false' || dataStr.includes('"false"')) patternsDiffer = true;
    }
    if (entry.event === 'DARK_SWATCH_DETECTED') isDark = true;
    if (entry.event === 'LIGHT_SWATCH_DETECTED') isDark = false;
  }

  if (patternsDiffer !== null && isDark !== null && (job.shot_type || job.detected_shot_type)) {
    return {
      signature: buildCaseSignature({
        category: job.category,
        shotType: job.detected_shot_type || job.shot_type,
        patternsDiffer,
        isDarkSwatch: isDark,
        opacity: sp?.opacity || null,
      }),
      source: 'backfill_inferred',
    };
  }

  return { signature: null, source: 'insufficient' };
}

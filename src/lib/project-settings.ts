// ─────────────────────────────────────────────────────────────────────────────
// Project Settings — Per-project configuration with system defaults
// ─────────────────────────────────────────────────────────────────────────────
// Settings are stored in `projects.metadata.settings` (JSONB).
// getProjectSettings() merges system defaults with project overrides.
// Projects without custom settings use system defaults transparently.
// ─────────────────────────────────────────────────────────────────────────────

export type ImageResolution = '1200x1200' | '1024x1024' | '768x768' | '512x512';
export type GenerationModeOverride = 'auto' | 'edit' | 'reference' | 'from_scratch';

export interface ProjectSettings {
  generation: {
    resolution: ImageResolution;
    temperature: number;         // 0.1 – 1.0
    mode: GenerationModeOverride; // 'auto' = use category default
  };
  qa: {
    auto_approve_threshold: number;  // 0.50 – 1.00
    retry_threshold: number;         // 0.30 – 0.90
    max_retries: number;             // 1 – 5
    product_fidelity_blocker: boolean;
    product_fidelity_blocker_threshold: number; // 0.20 – 0.80
  };
  scoring_weights: {
    product_fidelity: number;   // Sum of all 7 must = 1.0
    color_accuracy: number;
    composition_match: number;
    visual_quality: number;
    resolution: number;
    aspect_ratio: number;
    ml_compliance: number;
  };
  batch: {
    halt_flagged_percent: number;  // 0.10 – 0.50
    halt_min_processed: number;    // 1 – 20
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// System defaults — used when project has no custom settings
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  generation: {
    resolution: '1200x1200',
    temperature: 0.2,
    mode: 'auto',
  },
  qa: {
    auto_approve_threshold: 0.80,
    retry_threshold: 0.60,
    max_retries: 2,
    product_fidelity_blocker: true,
    product_fidelity_blocker_threshold: 0.40,
  },
  scoring_weights: {
    product_fidelity: 0.30,
    color_accuracy: 0.20,
    composition_match: 0.20,
    visual_quality: 0.15,
    resolution: 0.05,
    aspect_ratio: 0.05,
    ml_compliance: 0.05,
  },
  batch: {
    halt_flagged_percent: 0.20,
    halt_min_processed: 5,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Deep merge with validation & clamping
// ─────────────────────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !isNaN(v);
}

export function getProjectSettings(
  metadata: Record<string, unknown> | null | undefined
): ProjectSettings {
  const defaults = DEFAULT_PROJECT_SETTINGS;

  if (!metadata || !metadata.settings) {
    return { ...defaults };
  }

  const s = metadata.settings as Record<string, unknown>;

  // ── Generation ──
  const gen = (s.generation || {}) as Record<string, unknown>;
  const resolution = ['1200x1200', '1024x1024', '768x768', '512x512'].includes(gen.resolution as string)
    ? (gen.resolution as ImageResolution)
    : defaults.generation.resolution;
  const temperature = isNumber(gen.temperature)
    ? clamp(gen.temperature, 0.1, 1.0)
    : defaults.generation.temperature;
  const mode = ['auto', 'edit', 'reference', 'from_scratch'].includes(gen.mode as string)
    ? (gen.mode as GenerationModeOverride)
    : defaults.generation.mode;

  // ── QA ──
  const qa = (s.qa || {}) as Record<string, unknown>;
  const auto_approve = isNumber(qa.auto_approve_threshold)
    ? clamp(qa.auto_approve_threshold, 0.50, 1.00)
    : defaults.qa.auto_approve_threshold;
  const retry = isNumber(qa.retry_threshold)
    ? clamp(qa.retry_threshold, 0.30, 0.90)
    : defaults.qa.retry_threshold;
  const max_retries = isNumber(qa.max_retries)
    ? clamp(Math.round(qa.max_retries), 1, 5)
    : defaults.qa.max_retries;
  const fidelity_blocker = typeof qa.product_fidelity_blocker === 'boolean'
    ? qa.product_fidelity_blocker
    : defaults.qa.product_fidelity_blocker;
  const fidelity_threshold = isNumber(qa.product_fidelity_blocker_threshold)
    ? clamp(qa.product_fidelity_blocker_threshold, 0.20, 0.80)
    : defaults.qa.product_fidelity_blocker_threshold;

  // ── Scoring Weights ──
  const w = (s.scoring_weights || {}) as Record<string, unknown>;
  const weightKeys = [
    'product_fidelity', 'color_accuracy', 'composition_match',
    'visual_quality', 'resolution', 'aspect_ratio', 'ml_compliance',
  ] as const;

  const rawWeights: Record<string, number> = {};
  let hasCustomWeights = false;

  for (const key of weightKeys) {
    if (isNumber(w[key])) {
      rawWeights[key] = clamp(w[key] as number, 0, 1);
      hasCustomWeights = true;
    } else {
      rawWeights[key] = defaults.scoring_weights[key];
    }
  }

  // Normalize weights to sum to 1.0
  let scoring_weights = defaults.scoring_weights;
  if (hasCustomWeights) {
    const sum = Object.values(rawWeights).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      scoring_weights = {
        product_fidelity: rawWeights.product_fidelity / sum,
        color_accuracy: rawWeights.color_accuracy / sum,
        composition_match: rawWeights.composition_match / sum,
        visual_quality: rawWeights.visual_quality / sum,
        resolution: rawWeights.resolution / sum,
        aspect_ratio: rawWeights.aspect_ratio / sum,
        ml_compliance: rawWeights.ml_compliance / sum,
      };
    }
  }

  // ── Batch ──
  const batch = (s.batch || {}) as Record<string, unknown>;
  const halt_percent = isNumber(batch.halt_flagged_percent)
    ? clamp(batch.halt_flagged_percent, 0.10, 0.50)
    : defaults.batch.halt_flagged_percent;
  const halt_min = isNumber(batch.halt_min_processed)
    ? clamp(Math.round(batch.halt_min_processed), 1, 20)
    : defaults.batch.halt_min_processed;

  return {
    generation: { resolution, temperature, mode },
    qa: {
      auto_approve_threshold: auto_approve,
      retry_threshold: Math.min(retry, auto_approve - 0.05), // retry must be < approve
      max_retries,
      product_fidelity_blocker: fidelity_blocker,
      product_fidelity_blocker_threshold: fidelity_threshold,
    },
    scoring_weights,
    batch: {
      halt_flagged_percent: halt_percent,
      halt_min_processed: halt_min,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse resolution string to width/height
// ─────────────────────────────────────────────────────────────────────────────

export function parseResolution(res: ImageResolution): { width: number; height: number } {
  const [w, h] = res.split('x').map(Number);
  return { width: w, height: h };
}

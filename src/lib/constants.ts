export const PRODUCT_CATEGORIES = [
  { key: 'sabanas', label: 'Sabanas' },
  { key: 'toallas', label: 'Toallas' },
  { key: 'manteles', label: 'Manteles' },
  { key: 'cubrecamas', label: 'Cubrecamas' },
  { key: 'almohadas', label: 'Almohadas' },
  { key: 'quilts', label: 'Quilts' },
  { key: 'plumones', label: 'Plumones' },
  { key: 'frazadas', label: 'Frazadas' },
  { key: 'toppers', label: 'Toppers' },
  { key: 'alfombras', label: 'Alfombras' },
  { key: 'limpiapies', label: 'Limpiapies / Choapino' },
  { key: 'cortinas', label: 'Cortinas' },
  { key: 'cubre-colchon', label: 'Cubre Colchon Impermeable' },
  { key: 'bolsos-cuero', label: 'Bolsos de Cuero' },
  { key: 'bolsos-materos', label: 'Bolsos Materos' },
] as const;

export type ProductCategory = typeof PRODUCT_CATEGORIES[number]['key'];

export const SHOT_TYPES = [
  { key: 'main', label: 'Principal (Fondo blanco)' },
  { key: 'lifestyle', label: 'Lifestyle' },
  { key: 'detail', label: 'Detalle / Close-up' },
  { key: 'doblada', label: 'Doblada / Packaging' },
  { key: 'flatlay', label: 'Flat Lay' },
] as const;

export const COST_PER_IMAGE_USD = 0.050;
export const GEMINI_RPM_LIMIT = 9;
export const DELAY_BETWEEN_REQUESTS_SEC = 7;

// QA & chain constants
export const MAX_QA_RETRIES = 2;
export const BATCH_HALT_MIN_PROCESSED = 5;
export const BATCH_HALT_FLAGGED_PERCENT = 0.20;
// Stale-recovery threshold for /api/batches/[batchId]/health and the daily
// health-check cron. Sprint 5 Issue #0a: was 60s, raised to 300s after a race
// where a Flash→GPT-2 fallback chain ran ~200s without per-step heartbeats,
// tripping the old 60s threshold and letting the health endpoint reset the
// job mid-flight (allowing a parallel claim). With Fix B (no in-call fallback)
// no path should exceed 5 min; threshold can be lowered again once Sprint 5
// Issue #4 (heartbeat pattern in adapters) is in place.
export const CHAIN_STALE_THRESHOLD_MS = 300 * 1000; // 5 minutes

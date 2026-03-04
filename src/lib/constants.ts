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

export const COST_PER_IMAGE_USD = 0.045;
export const GEMINI_RPM_LIMIT = 9;
export const DELAY_BETWEEN_REQUESTS_SEC = 7;

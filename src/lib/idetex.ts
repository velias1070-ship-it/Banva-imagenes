import { createClient } from '@supabase/supabase-js';

/**
 * Idetex product resolver — finds the idetex.cl product URL for a BANVA SKU
 * by querying their search endpoint and scoring results against expected slug
 * tokens. Works across product families (plumones, frazadas, sábanas, quilts,
 * alfombras, etc.) without hardcoded per-family rules.
 *
 * Source of truth for "is this SKU from Idetex?" is `productos.proveedor` in
 * the banvabodega Supabase. The BRAND attribute on ML is unreliable (e.g.
 * alfombras have BRAND="Genérica" but are stocked from Idetex).
 */

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

const TITLE_STOPWORDS = new Set([
  // Spanish stopwords
  'de', 'la', 'el', 'en', 'con', 'para', 'del', 'al', 'a', 'y', 'e', 'o', 'u',
  'lo', 'los', 'las', 'un', 'una', 'unos', 'unas', 'su', 'sus',
  // Units
  'cm', 'mm', 'm', 'mt', 'mts', 'metro', 'metros', 'kg', 'gr', 'gramos',
  // Generic descriptors used in BANVA listings
  'calidad', 'premium', 'varios', 'colores', 'color',
  'pelo', 'largo', 'corto', 'suave', 'antideslizante',
  'reversible', 'invierno', 'verano', 'cama',
  'sin', 'incluye', 'set', 'juego', 'pack', 'mercadolibre', 'envio', 'envío',
  // Product family words — handled via productType slot, not as discriminators
  'plumon', 'plumones', 'frazada', 'frazadas',
  'sabana', 'sabanas', 'quilt', 'quilts',
  'cubrecama', 'cubrecamas', 'alfombra', 'alfombras',
  'toalla', 'toallas', 'manta', 'mantas',
  'cobertor', 'cobertores', 'cortina', 'cortinas',
  // Size words — handled via size candidates
  'plazas', 'plaza', 'king', 'queen', 'single', 'super', 'twin', 'full',
]);

const GENERIC_DESIGN_WORDS = new Set([
  'estampado', 'estampada', 'estampados', 'estampadas',
  'liso', 'lisa', 'lisos', 'lisas',
  'unicolor', 'solido',
]);

// BRAND values that don't help discriminate (BANVA-manufactured or unbranded).
const NON_DISCRIMINATING_BRANDS = new Set(['generica', 'unbranded', 'sin marca']);

// Fallback brand allowlist for SKUs not classified in productos.proveedor yet.
const KNOWN_IDETEX_BRANDS = ['valencia', 'illusions'];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function tokenizeSlug(url: string): Set<string> {
  // Drop https://idetex.cl/ prefix and .html suffix, then tokenize the path
  // (which includes both the category folder and the product slug).
  const path = url.replace(/^https?:\/\/idetex\.cl\//, '').replace(/\.html$/, '');
  return new Set(normalize(path).split(/\s+/).filter(Boolean));
}

function extractDistinctiveTitleTokens(title: string): string[] {
  return tokenize(title).filter((t) =>
    t.length >= 3 &&
    !TITLE_STOPWORDS.has(t) &&
    !/^\d+([.,]\d+)?$/.test(t)
  );
}

function isBrandUseful(brand: string | undefined | null): boolean {
  if (!brand) return false;
  return !NON_DISCRIMINATING_BRANDS.has(normalize(brand));
}

function parseDimensionCm(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = v.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(cm|m)\b/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return m[2] === 'm' ? Math.round(n * 100) : Math.round(n);
}

/**
 * Generate every plausible size suffix that might appear in an Idetex URL slug.
 * Covers bedding (plazas → king/queen/single/super-king/20p/1-5-plaza) and
 * dimensional products like alfombras (WIDTH × LENGTH in cm → 050x100, 50x100).
 */
export function getSizeSlugCandidates(attrs: Record<string, string>): string[] {
  const candidates: string[] = [];

  // Plazas-style sizes (plumones, frazadas, sábanas, quilts, cubrecamas)
  const plazasRaw = (
    attrs.COMFORTER_MATTRESS_SIZE ||
    attrs.MATTRESS_SIZE ||
    attrs.BLANKET_SIZE ||
    attrs.BEDDING_SIZE ||
    ''
  ).toLowerCase().trim();

  if (plazasRaw) {
    if (/super\s*king/.test(plazasRaw)) candidates.push('super-king');
    else if (/\bking\b/.test(plazasRaw)) candidates.push('king');
    else if (/\bqueen\b/.test(plazasRaw)) candidates.push('queen');
    else if (/\bsingle\b/.test(plazasRaw)) candidates.push('single');

    const m = plazasRaw.match(/(\d+(?:[.,]\d+)?)\s*plazas?/);
    if (m) {
      const numStr = m[1].replace(',', '.');
      const num = parseFloat(numStr);
      if (!Number.isNaN(num)) candidates.push(`${Math.round(num * 10)}p`);
      const wordMap: Record<string, string> = {
        '1': 'single', '1.5': 'single', '2': 'queen', '2.5': 'king', '3': 'super-king',
      };
      if (wordMap[numStr]) candidates.push(wordMap[numStr]);
      const dashed = numStr.replace('.', '-');
      candidates.push(`${dashed}-plaza`, `${dashed}-plazas`);
    }
  }

  // Dimension-style (alfombras): WIDTH × LENGTH in cm, both padded and unpadded.
  const w = parseDimensionCm(attrs.WIDTH);
  const l = parseDimensionCm(attrs.LENGTH);
  if (w && l) {
    const wPad3 = w.toString().padStart(3, '0');
    const lPad3 = l.toString().padStart(3, '0');
    candidates.push(`${wPad3}x${lPad3}`, `${w}x${l}`);
    // Also try reversed orientation for products where ML attrs disagree on axis
    candidates.push(`${lPad3}x${wPad3}`, `${l}x${w}`);
  }

  return Array.from(new Set(candidates));
}

/**
 * Build a ranked list of search queries (most specific first, most relaxed last).
 * Each query gets tried in order until one returns scoreable results.
 */
export function buildIdetexQueries(
  attrs: Record<string, string>,
  title: string | undefined
): string[] {
  const fabricDesign = attrs.FABRIC_DESIGN;
  const fabricIsGeneric =
    !fabricDesign || GENERIC_DESIGN_WORDS.has(normalize(fabricDesign));
  const designOrColor = fabricIsGeneric
    ? (attrs.MAIN_COLOR || attrs.COLOR)
    : fabricDesign;

  const productType = attrs.COMFORTER_TYPE || attrs.PRODUCT_TYPE;
  const model = (attrs.MODEL || '').replace(/^MF\s+/i, '');
  const brand = isBrandUseful(attrs.BRAND) ? attrs.BRAND : undefined;

  const queries: string[] = [];
  const push = (parts: (string | null | undefined)[]) => {
    const q = parts.filter((p): p is string => Boolean(p)).map(normalize).join(' ').trim();
    if (q && !queries.includes(q)) queries.push(q);
  };

  // Most specific → progressively relaxed
  push([productType, model, brand, designOrColor]);
  push([model, brand, designOrColor]);
  push([model, designOrColor]);

  if (title) {
    const tokens = extractDistinctiveTitleTokens(title);
    if (tokens.length > 0) {
      const colorTok = designOrColor ? normalize(designOrColor) : '';
      const merged = [...tokens.slice(0, 3), colorTok].filter(Boolean);
      push([Array.from(new Set(merged)).join(' ')]);
    }
  }

  if (designOrColor) push([designOrColor]);

  return queries;
}

/**
 * Tokens that should appear in the final URL slug for a confident match.
 * Returned in two tiers: mustHave (heavy weight) and niceToHave (light weight).
 */
export function buildExpectedSlugTokens(
  attrs: Record<string, string>,
  title: string | undefined
): { mustHave: string[]; niceToHave: string[] } {
  const fabricDesign = attrs.FABRIC_DESIGN;
  const fabricIsGeneric =
    !fabricDesign || GENERIC_DESIGN_WORDS.has(normalize(fabricDesign));
  const designOrColor = fabricIsGeneric
    ? (attrs.MAIN_COLOR || attrs.COLOR)
    : fabricDesign;

  const model = (attrs.MODEL || '').replace(/^MF\s+/i, '');
  const modelTokens = tokenize(model);

  const mustHave = new Set<string>();
  if (designOrColor) {
    for (const t of tokenize(designOrColor)) mustHave.add(t);
  }
  for (const t of modelTokens) mustHave.add(t);

  const niceToHave = new Set<string>(
    title ? extractDistinctiveTitleTokens(title) : []
  );
  // Don't double-count must-have tokens as nice-to-have
  for (const t of mustHave) niceToHave.delete(t);

  return {
    mustHave: Array.from(mustHave).filter((t) => t.length >= 2),
    niceToHave: Array.from(niceToHave),
  };
}

function scoreUrl(
  url: string,
  mustHave: string[],
  niceToHave: string[],
  sizeCandidates: string[]
): number {
  const tokens = tokenizeSlug(url);
  const slugText = Array.from(tokens).join(' ');

  let score = 0;

  for (const t of mustHave) {
    if (tokens.has(t)) score += 3;
    else if (slugText.includes(t)) score += 1; // partial credit for substrings
  }

  for (const t of niceToHave) {
    if (tokens.has(t)) score += 1;
  }

  for (const s of sizeCandidates) {
    if (tokens.has(s) || slugText.includes(s)) {
      score += 5;
      break;
    }
  }

  return score;
}

export async function searchIdetexUrls(query: string): Promise<string[]> {
  if (!query) return [];
  const url = `https://idetex.cl/buscar?controller=search&s=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.match(/https:\/\/idetex\.cl\/[^"' >]+\.html/g) || [];
    // Only product detail pages: category/{id}-{slug}.html
    return Array.from(new Set(matches)).filter((u) => /\/\d+-[^/]+\.html$/.test(u));
  } catch {
    return [];
  }
}

export interface IdetexResolveResult {
  url: string;
  score: number;
  query: string;
}

export interface IdetexResolveDebug {
  queries: string[];
  mustHave: string[];
  niceToHave: string[];
  sizeCandidates: string[];
  minScore: number;
  attempts: Array<{
    query: string;
    results: number;
    top: Array<{ url: string; score: number }>;
  }>;
}

/**
 * Resolve a BANVA SKU's ML attributes to a single idetex.cl product URL.
 *
 * Tries each candidate query in turn, scores every result, and returns the
 * highest-scoring URL above the minimum threshold. Returns null when no URL
 * scores high enough — preferable to silently picking a wrong product.
 */
export async function resolveIdetexProductUrl(
  attrs: Record<string, string>,
  title: string | undefined
): Promise<{ result: IdetexResolveResult | null; debug: IdetexResolveDebug }> {
  const queries = buildIdetexQueries(attrs, title);
  const { mustHave, niceToHave } = buildExpectedSlugTokens(attrs, title);
  const sizeCandidates = getSizeSlugCandidates(attrs);

  // Floor for a believable match: at least one must-have token plus the size.
  // mustHave.length * 1.5 ≈ majority of must-haves must hit. Always require >= 5.
  const minScore = Math.max(5, Math.ceil(mustHave.length * 1.5));

  const debug: IdetexResolveDebug = {
    queries, mustHave, niceToHave, sizeCandidates, minScore, attempts: [],
  };

  let best: IdetexResolveResult | null = null;

  for (const query of queries) {
    const urls = await searchIdetexUrls(query);
    const scored = urls.map((u) => ({
      url: u,
      score: scoreUrl(u, mustHave, niceToHave, sizeCandidates),
    }));
    scored.sort((a, b) => b.score - a.score);

    debug.attempts.push({
      query,
      results: urls.length,
      top: scored.slice(0, 3),
    });

    for (const candidate of scored) {
      if (candidate.score < minScore) break; // sorted desc
      if (!best || candidate.score > best.score) {
        best = { url: candidate.url, score: candidate.score, query };
      }
    }

    // Stop early if we already have a strong match.
    if (best && best.score >= minScore + 5) break;
  }

  return { result: best, debug };
}

export async function extractAllProductImages(pageUrl: string): Promise<string[]> {
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.matchAll(/property=["']og:image["']\s+content=["']([^"']+)["']/gi);
    const urls = new Set<string>();
    for (const m of matches) urls.add(m[1]);
    return Array.from(urls);
  } catch {
    return [];
  }
}

/**
 * Authoritative check: is this SKU sourced from Idetex per productos.proveedor?
 * Falls back to BRAND attribute for SKUs not yet classified in productos
 * (Valencia and Illusions brands are exclusively Idetex on the BANVA catalog).
 */
export async function isIdetexSku(
  sku: string,
  attrs: Record<string, string>
): Promise<{ ok: boolean; reason: string }> {
  try {
    const db = getInventorySupabase();
    const { data } = await db
      .from('productos')
      .select('proveedor')
      .eq('sku', sku)
      .maybeSingle();
    if (data?.proveedor === 'Idetex') {
      return { ok: true, reason: 'productos.proveedor=Idetex' };
    }
    if (data?.proveedor && data.proveedor !== 'Idetex') {
      return {
        ok: false,
        reason: `productos.proveedor="${data.proveedor}" (not Idetex)`,
      };
    }
  } catch {
    // fall through to brand-based fallback
  }

  // SKU not in productos — fall back to BRAND allowlist.
  const brand = (attrs.BRAND || '').toLowerCase();
  if (KNOWN_IDETEX_BRANDS.some((b) => brand.includes(b))) {
    return { ok: true, reason: `BRAND="${attrs.BRAND}" (allowlist fallback)` };
  }

  return {
    ok: false,
    reason: `SKU ${sku} not in productos.proveedor and BRAND "${attrs.BRAND || 'unknown'}" not in fallback allowlist`,
  };
}

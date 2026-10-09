/**
 * Revisión por modelo del paso de marca (BRAND_ONLY), ANTES de aprobar.
 *
 * El paso de marca tenía sólo chequeos de código (recorte, deriva de la tela, texto contra la
 * zona del logo) y se aprobaba solo con qa_score 0,95: nadie miraba si el texto quedó legible
 * ni si el logo se ve. Acá un modelo mira la imagen de antes, la de después y un recorte
 * ampliado de la esquina del logo, y le pone una nota de 1 a 5 a cada punto. Con 1 o 2 en la
 * legibilidad del texto o en la del logo (o si el logo tapa contenido) la imagen queda `flagged`
 * con el motivo en `qa_feedback`; con 3 o más se aprueba como siempre.
 *
 * Calibración (09-oct-2026, Gemini 2.5 Flash; WHERE: 120 pares antes/después de trabajos
 * BRAND_ONLY aprobados en los 45 días previos, elegidos por orden de md5, 111 de Banva Home y
 * 9 de American Family; el detalle va en la PR):
 *  - Notas y no sí/no: con preguntas de sí/no (primera versión) el modelo aprobó 33 de 36
 *    pruebas (los 12 pares reales y 21 de 24 controles armados a propósito) y no deja elegir
 *    cuán estricto ser; con notas de 1 a 5 el umbral se elige mirando cómo se reparten.
 *  - Temperatura 0 y no 0,1: con 0,1 dos corridas sobre las mismas 120 imágenes marcaron 9 y 9,
 *    con sólo 3 en común. Con 0, dos corridas sobre 40 de ellas marcaron 10 y 7, con 7 en común;
 *    esas 40 son las que alguna corrida a 0,1 había marcado (más algunas al azar), así que
 *    muestran cuánto cambia lo dudoso con 0, no cuánto mejora respecto de 0,1.
 *  - Con 1 o 2 en texto o logo, o logo que tapa, quedan marcadas 15 de las 120 (12,5 %); con
 *    3 o menos serían 34 (28 %) y con 1 sola nota quedarían 2. A ojo, las marcadas son sobre
 *    todo texto dorado pálido sobre fondo claro y logo azul sobre fondo oscuro o texturado,
 *    más unos pocos casos dudosos (texto chico gris sobre crema).
 *  - La nota del logo por sí sola no separa (se queja del eslogan chico del logo en cualquier
 *    fondo): sólo se confía en 1-2.
 *  - `brand_match` (¿colores y tipografía de la marca?) NO decide: dio 1 en 4 de las 120, a ojo
 *    una con texto ilegible de verdad, dos bien y una dudosa, y entre dos corridas a 0,1 18 de
 *    las 117 notas comparables distaron 2 o más puntos. Se pide igual y queda en el
 *    pipeline_log para calibrarlo con datos reales.
 *  - Límite: lo dudoso cambia de una corrida a otra (con 0,1 la nota del texto distó 2 o más
 *    puntos en 14 de 119 pares); esto frena lo claramente malo, no todo lo mejorable.
 *
 * Si el modelo NO puede revisar (error de red, límite de uso, tiempo, respuesta que no es JSON)
 * no se inventa un veredicto: devuelve 'unavailable' y la ruta aprueba como hasta ahora, pero lo
 * anota en `qa_feedback` y en el pipeline_log (evento BRAND_REVIEW).
 *
 * Las funciones puras (prompt, parseo, decisión, resultado) se prueban sin red en
 * scripts/test-brand-reviewer.ts.
 */
import sharp from 'sharp';
import { analyzeImages } from '@/lib/gemini/client';
import { ensureOutputSpec } from '@/lib/image-processing';
import { getLogoBbox, type BrandConfig } from '@/lib/brand';

/**
 * Modelo que revisa. Fijo (como en la detección de cajas de texto de este mismo paso) para que el
 * modelo calibrado sea el que corre aunque alguien defina GEMINI_ANALYSIS_MODEL.
 */
export const BRAND_REVIEW_MODEL = 'gemini-2.5-flash';

/** Temperatura 0: la misma imagen recibe casi siempre la misma nota (ver cabecera). */
export const BRAND_REVIEW_TEMPERATURE = 0;

/** La imagen pasa con nota >= a esto (1 y 2 = falla) en texto y en logo. */
export const NOTA_MINIMA = 3;

/** Tope de espera de la revisión: la ruta tiene 300 s y ya gastó hasta dos intentos de Gemini. */
export const BRAND_REVIEW_TIMEOUT_MS = 45_000;

/** Ancho (px) al que se amplía el recorte de la esquina del logo antes de mandarlo al modelo. */
const ZOOM_LOGO_PX = 840;

export type BrandReviewVerdict = 'ok' | 'fail' | 'unavailable';

/** Respuesta del modelo ya validada. Las notas son enteros de 1 a 5; null = no aplica. */
export interface ParsedBrandReview {
  text_readability: number | null;
  weakest_text: string;
  /** Sólo se registra (no decide): ver cabecera. */
  brand_match: number | null;
  brand_mismatch: string;
  logo_readability: number | null;
  logo_problem: string;
  logo_covers_content: boolean;
}

export interface BrandReview {
  verdict: BrandReviewVerdict;
  /** Un motivo por cada punto que quedó bajo el umbral, en español. Vacío si no es 'fail'. */
  problems: string[];
  /** Una frase para `qa_feedback` y el pipeline_log. */
  summary: string;
  /** Modelo que contestó (null si no hubo respuesta). */
  model: string | null;
  durationMs: number;
  /** Tokens de entrada y de salida (la salida incluye el razonamiento del modelo); null si la API no los informó. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Lo que contestó el modelo, validado (null si no hubo respuesta usable). Va al pipeline_log. */
  answer: ParsedBrandReview | null;
}

const MAX_RULES_CHARS = 800;
const MAX_FEEDBACK_CHARS = 400;
const MAX_REASON_CHARS = 160;

/** Los campos de la marca vienen de un formulario: traen espacios y saltos de línea de más. */
function limpio(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim();
}

function color(v: string | null | undefined): string {
  return limpio(v) || 'not specified';
}

/** La URL de la API de Gemini lleva la clave en la query: nunca debe llegar a la base ni a la pantalla. */
export function sinClave(texto: string): string {
  return texto.replace(/key=[^&\s"')]+/gi, 'key=<redactado>');
}

/**
 * Tipografía que se le pide al paso de marca: la de cada rol si hay alguna (igual que
 * `buildBrandPromptSection`), y si no, la única de la marca.
 */
export function describeBrandFonts(
  brand: Pick<BrandConfig, 'typography' | 'typography_title' | 'typography_subtitle' | 'typography_subsubtitle'>,
): string {
  const title = limpio(brand.typography_title);
  const subtitle = limpio(brand.typography_subtitle);
  const subsub = limpio(brand.typography_subsubtitle);
  if (title || subtitle || subsub) {
    return [
      title && `titles: ${title}`,
      subtitle && `subtitles and labels: ${subtitle}`,
      subsub && `body and features: ${subsub}`,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  return limpio(brand.typography) || 'not specified';
}

export function buildBrandReviewPrompt(
  brand: BrandConfig,
  opts: { textChanged: boolean; hasLogo: boolean },
): string {
  const { textChanged, hasLogo } = opts;
  const rules = limpio(brand.prompt_guidelines).slice(0, MAX_RULES_CHARS);
  const corner = brand.logo_position || 'top-left';

  const images = [
    `IMAGE 1 is the BEFORE: the image without the brand applied.`,
    `IMAGE 2 is the AFTER: the result to judge. ${
      textChanged
        ? 'An AI model recolored and re-fonted its text to the brand book'
        : 'Its text was left as it was'
    }${hasLogo ? `, and then a program pasted the brand logo in the ${corner} corner` : ''}.`,
    hasLogo
      ? `IMAGE 3 is a ZOOM of the ${corner} corner of Image 2, enlarged, where the logo was pasted.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const brandMatch = textChanged
    ? `B. brand_match — Compare the text in Image 2 with the brand book: the main title with the title color, the other text with the subtitle and accent colors, the letterforms with the brand fonts (same type family: geometric sans-serif, serif, script...). Allow small differences from lighting, anti-aliasing or the exact font. 5 = colors and type style clearly follow the brand book; 3 = mixed or unsure (some text keeps another color or style); 1 = clearly different colors or type style (for example a serif or script font where sans-serif is required, or a red title where dark blue is required). null = the image has no text.`
    : `B. brand_match — Not applicable in this run (the text was left as it was). Answer null.`;

  const logo = hasLogo
    ? `C. logo_readability — Look at Image 3, the zoomed corner. 5 = every letter and the symbol of the logo are crisp and stand out clearly from what is behind them; 4 = readable, but part of the logo competes with the background (leaves, pattern, similar color); 3 = some letters or the small tagline are partly lost; 2 = hard to make out; 1 = camouflaged or cut off.
D. logo_covers_content — true if the logo hides text, a product detail or a person; otherwise false.`
    : `C. logo_readability — There is no logo in this run. Answer null.
D. logo_covers_content — Answer false.`;

  return `You are a quality inspector for e-commerce product images that carry brand text and a brand logo.

${images}
Judge ONLY Image 2${hasLogo ? ' (and Image 3 for the logo)' : ''}. Use Image 1 just to see what was there before (text, product details).

BRAND BOOK — brand "${brand.name}":
- Title color: ${color(brand.primary_color)}
- Subtitle, body and label color: ${color(brand.secondary_color)}
- Accent color (features, icon labels): ${color(brand.accent_color)}
- Fonts: ${describeBrandFonts(brand)}${rules ? `\n- Extra rules: ${rules}` : ''}

Rate each point from 1 to 5 (null when it does not apply). Be practical: rate what a shopper would notice in a marketplace listing, with the image shown about 600px wide.

A. text_readability — the HARDEST-to-read text in Image 2. 5 = all the text is crisp and high-contrast; 4 = all clearly readable, some of it small or in a light color; 3 = readable with some effort (small or low contrast); 2 = some text is very hard to read (it nearly blends into the background, overlaps other text or is cut off); 1 = some text cannot be read at all. null = the image has no text.
${brandMatch}
${logo}

Write every free-text field in Spanish, short (at most 20 words).
Respond ONLY with valid JSON (no markdown, no backticks):
{
  "text_readability": 1-5 or null,
  "weakest_text": "which text is the hardest to read and why, or 'ninguno'",
  "brand_match": 1-5 or null,
  "brand_mismatch": "what does not match the brand book, or 'ninguno'",
  "logo_readability": 1-5 or null,
  "logo_problem": "which part of the logo is hard to see or what it covers, or 'ninguno'",
  "logo_covers_content": true or false
}`;
}

/** Nota entera de 1 a 5; null si el modelo dijo null; undefined si el valor no sirve. */
function parseNota(v: unknown): number | null | undefined {
  if (v === null) return null;
  const n = typeof v === 'string' && /^\s*\d+(\.0+)?\s*$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

/**
 * Valida la respuesta del modelo. Devuelve null si no es un JSON con las notas que deciden
 * (texto y logo, más `logo_covers_content` booleano): una respuesta rota no es ni "pasa" ni
 * "falla". `brand_match` ausente o inválido cuenta como "no aplica" (no decide).
 */
export function parseBrandReview(raw: string): ParsedBrandReview | null {
  // Entre la primera { y la última }: tolera ```json ... ``` y texto alrededor.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const texto = parseNota(o.text_readability);
  const logo = parseNota(o.logo_readability);
  if (texto === undefined || logo === undefined) return null;
  if (typeof o.logo_covers_content !== 'boolean') return null;
  // brand_match sólo se registra: ausente o roto (un «n/a», un 0) cuenta como «no aplica» en vez de
  // tirar una respuesta cuyo veredicto —texto y logo— sí es usable.
  const marca = parseNota(o.brand_match) ?? null;

  const str = (v: unknown) => (typeof v === 'string' ? limpio(v) : '');
  return {
    text_readability: texto,
    weakest_text: str(o.weakest_text),
    brand_match: marca,
    brand_mismatch: str(o.brand_mismatch),
    logo_readability: logo,
    logo_problem: str(o.logo_problem),
    logo_covers_content: o.logo_covers_content,
  };
}

const SIN_MOTIVO = /^(ninguno|ninguna|none|n\/a|no aplica|-)?\.?$/i;

function motivo(detalle: string, porDefecto: string): string {
  return SIN_MOTIVO.test(detalle) ? porDefecto : detalle.replace(/\.$/, '');
}

/**
 * Convierte la respuesta validada en veredicto. La legibilidad del texto cuenta siempre; la del
 * logo y «tapa contenido» sólo si en esta corrida se pegó un logo. `brand_match` no decide.
 */
export function decideBrandReview(
  parsed: ParsedBrandReview,
  opts: { hasLogo: boolean },
): { verdict: 'ok' | 'fail'; problems: string[]; summary: string } {
  const problems: string[] = [];
  const { text_readability: texto, logo_readability: logo } = parsed;

  if (texto !== null && texto < NOTA_MINIMA) {
    problems.push(`Texto difícil de leer (${texto}/5): ${motivo(parsed.weakest_text, 'no se distingue bien')}`);
  }
  if (opts.hasLogo) {
    if (parsed.logo_covers_content) {
      problems.push(`Logo tapa contenido o se pierde: ${motivo(parsed.logo_problem, 'esconde texto o producto')}`);
    } else if (logo !== null && logo < NOTA_MINIMA) {
      problems.push(`Logo poco legible (${logo}/5): ${motivo(parsed.logo_problem, 'se pierde con el fondo')}`);
    }
  }
  if (problems.length === 0) return { verdict: 'ok', problems, summary: 'Sin problemas graves' };
  return { verdict: 'fail', problems, summary: problems.join(' · ').slice(0, MAX_FEEDBACK_CHARS) };
}

/**
 * Recorte ampliado de la esquina donde va el logo (la caja del logo más su margen). Con el
 * logo a 200 px sobre 1.200 el modelo no distingue sus letras entre hojas; ampliado, sí.
 */
export async function cropLogoZone(afterBuffer: Buffer, brand: BrandConfig): Promise<Buffer> {
  const meta = await sharp(afterBuffer).metadata();
  const w = meta.width || 1200;
  const h = meta.height || 1200;
  const box = getLogoBbox(brand, w, h);
  const pad = brand.logo_margin_px;
  const left = Math.min(Math.max(0, box.x - pad), w - 1);
  const top = Math.min(Math.max(0, box.y - pad), h - 1);
  const width = Math.min(box.width + 2 * pad, w - left);
  const height = Math.min(box.height + 2 * pad, h - top);
  return sharp(afterBuffer)
    .extract({ left, top, width, height })
    .resize({ width: ZOOM_LOGO_PX, kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

type Uso = Pick<BrandReview, 'model' | 'inputTokens' | 'outputTokens'>;

const SIN_USO: Uso = { model: null, inputTokens: null, outputTokens: null };

function unavailable(motivoNoRevisada: string, uso: Uso, start: number): BrandReview {
  return {
    verdict: 'unavailable',
    problems: [],
    summary: sinClave(motivoNoRevisada).slice(0, MAX_REASON_CHARS),
    ...uso,
    answer: null,
    durationMs: Date.now() - start,
  };
}

const AGOTADO = Symbol('revision-agotada');

/** Espera la promesa hasta `ms`; pasado el tiempo devuelve AGOTADO (la llamada sigue, su resultado se ignora). */
async function conLimite<T>(promesa: Promise<T>, ms: number): Promise<T | typeof AGOTADO> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<typeof AGOTADO>((resolve) => {
    timer = setTimeout(() => resolve(AGOTADO), ms);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pide al modelo que revise un paso de marca. Nunca lanza: ante cualquier problema devuelve
 * 'unavailable' con el motivo.
 *
 * @param beforeBuffer imagen de antes (sin marca), la que el paso de marca tomó como base
 * @param afterBuffer  resultado ya con el logo pegado: es lo que se va a aprobar
 * @param textChanged  false si el paso de marca cayó al respaldo (sólo logo, texto sin cambiar)
 * @param hasLogo      true sólo si `overlayBrandLogo` de verdad pegó un logo (no pega si la marca lo
 *                     tiene apagado, el tipo de toma no entra en su filtro o no se pudo bajar)
 * @param timeoutMs    sólo para pruebas; en producción corre BRAND_REVIEW_TIMEOUT_MS
 */
export async function reviewBrandPass(input: {
  beforeBuffer: Buffer;
  afterBuffer: Buffer;
  brand: BrandConfig;
  textChanged: boolean;
  hasLogo: boolean;
  timeoutMs?: number;
}): Promise<BrandReview> {
  const start = Date.now();
  const opts = { textChanged: input.textChanged, hasLogo: input.hasLogo };
  try {
    const before = await ensureOutputSpec(input.beforeBuffer, 1200);
    const images = [
      { base64: before.toString('base64'), mimeType: 'image/png' },
      { base64: input.afterBuffer.toString('base64'), mimeType: 'image/png' },
    ];
    if (opts.hasLogo) {
      const zoom = await cropLogoZone(input.afterBuffer, input.brand);
      images.push({ base64: zoom.toString('base64'), mimeType: 'image/png' });
    }
    const res = await conLimite(
      analyzeImages({
        images,
        promptText: buildBrandReviewPrompt(input.brand, opts),
        temperature: BRAND_REVIEW_TEMPERATURE,
        // Como la detección de cajas de texto de este mismo paso: falla rápido en vez de gastar el
        // presupuesto de la ruta esperando un 429.
        maxRetries: 1,
        modelOverride: BRAND_REVIEW_MODEL,
      }),
      input.timeoutMs ?? BRAND_REVIEW_TIMEOUT_MS,
    );
    if (res === AGOTADO) {
      console.error('[brand-review] el modelo no respondió a tiempo');
      return unavailable('el modelo no respondió a tiempo', SIN_USO, start);
    }
    const usage = res.meta?.usageMetadata;
    const uso: Uso = {
      model: res.meta?.modelVersion ?? res.meta?.modelUsed ?? null,
      inputTokens: usage?.promptTokenCount ?? null,
      // total − entrada: incluye el razonamiento del modelo, que también se cobra como salida.
      outputTokens:
        usage?.totalTokenCount != null && usage.promptTokenCount != null
          ? usage.totalTokenCount - usage.promptTokenCount
          : null,
    };

    if (!res.success || !res.textResponse) {
      console.error(`[brand-review] el modelo no respondió: ${sinClave(res.error ?? 'sin texto')}`);
      return unavailable(`el modelo no respondió (${res.error ?? 'sin texto'})`, uso, start);
    }

    const parsed = parseBrandReview(res.textResponse);
    if (!parsed) {
      console.error(`[brand-review] respuesta que no es JSON válido: ${res.textResponse.slice(0, 300)}`);
      return unavailable('la respuesta del modelo no se pudo leer', uso, start);
    }

    const decision = decideBrandReview(parsed, opts);
    return { ...decision, ...uso, answer: parsed, durationMs: Date.now() - start };
  } catch (err) {
    const msg = sinClave(err instanceof Error ? err.message : 'error desconocido');
    console.error(`[brand-review] error: ${msg}`);
    return unavailable(`error al revisar (${msg})`, SIN_USO, start);
  }
}

/**
 * Qué se escribe en la fila del trabajo al terminar el paso de marca.
 *
 * - 'fail'        → flagged, sin qa_score (no hay número honesto) y el motivo en qa_feedback.
 * - 'unavailable' → aprobada como hasta ahora, pero el texto dice que NO se revisó.
 * - 'ok' / sin revisión (la marca no existe) → aprobada como hasta ahora.
 *
 * El 0,95 de `qa_score` es el valor fijo de siempre al aprobar un paso de marca; esta revisión
 * no calcula un puntaje, sólo aprueba o rechaza.
 */
export function brandPassOutcome(
  review: BrandReview | null,
  usedGemini: boolean,
): { status: 'approved' | 'flagged'; qa_score: number | null; qa_feedback: string } {
  const via = usedGemini ? 'BRAND_ONLY Gemini' : 'BRAND_ONLY Sharp fallback';
  if (review?.verdict === 'fail') {
    return { status: 'flagged', qa_score: null, qa_feedback: `Revisión de marca: ${review.summary}` };
  }
  if (review?.verdict === 'unavailable') {
    return {
      status: 'approved',
      qa_score: 0.95,
      qa_feedback: `Auto-approved (${via}) — SIN revisión de marca: ${review.summary}`,
    };
  }
  if (review?.verdict === 'ok') {
    return {
      status: 'approved',
      qa_score: 0.95,
      qa_feedback: `Aprobada (${via}) · revisión de marca: sin problemas graves`,
    };
  }
  return { status: 'approved', qa_score: 0.95, qa_feedback: `Auto-approved (${via})` };
}

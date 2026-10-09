/**
 * Pruebas sin red del revisor por modelo del paso de marca (src/lib/brand-reviewer.ts).
 *
 * Cubre lo que se puede probar sin llamar a Gemini: el prompt, la lectura de la respuesta, la
 * regla que decide (en los bordes: la nota 2 falla, la 3 pasa), el recorte ampliado del logo, los
 * caminos de `reviewBrandPass` contra un `fetch` falso (bien, mal, error HTTP, respuesta sin JSON,
 * sin respuesta a tiempo, clave dentro del mensaje de error) y lo que se escribe en la fila del
 * trabajo (`brandPassOutcome`).
 *
 * NO prueba al modelo: qué tan bien separa lo legible de lo ilegible se midió aparte (cabecera de
 * brand-reviewer.ts). Tampoco prueba la ruta que lo llama (necesita Supabase y Storage).
 *
 * Uso: npx tsx scripts/test-brand-reviewer.ts  (no llama a ninguna API; costo $0)
 */
import sharp from 'sharp';
import type { BrandConfig } from '../src/lib/brand';
import type { BrandReview, ParsedBrandReview } from '../src/lib/brand-reviewer';

// El cliente de Gemini lee la clave al cargarse: va ANTES de importarlo. Siempre una falsa (no
// `||=`): la prueba de «la clave no se filtra» busca un valor conocido y, si el fetch falso
// fallara, no habría ninguna clave real que mandar.
const CLAVE = 'clave-falsa-de-prueba';
process.env.GEMINI_API_KEY = CLAVE;

// ── fetch falso ─────────────────────────────────────────────────────────────────────────────
type Parte = { inline_data?: { mime_type: string; data: string }; text?: string };
type Llamada = { url: string; partes: Parte[]; temperatura: number };

const llamadas: Llamada[] = [];
let responder: () => Promise<Response> = async () => {
  throw new Error('la prueba no preparó una respuesta');
};

globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  const cuerpo = JSON.parse(String(init?.body ?? '{}'));
  llamadas.push({
    url: String(url),
    partes: cuerpo.contents?.[0]?.parts ?? [],
    temperatura: cuerpo.generationConfig?.temperature,
  });
  return responder();
}) as typeof fetch;

// Lo que el módulo escribe con console.* (el recorte avisa cada vez) no es la salida de la prueba.
const log = console.log.bind(console);
const escritoPorElModulo: string[] = [];
console.log = (...a: unknown[]) => {
  escritoPorElModulo.push(a.join(' '));
};
console.error = console.log;

// ── ayudas ──────────────────────────────────────────────────────────────────────────────────
let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  log(`${cond ? 'OK   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}
function igual(real: unknown, esperado: unknown, msg: string) {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  log(`${a === b ? 'OK   ' : 'FALLA'} ${msg}${a === b ? '' : `\n        real:     ${a}\n        esperado: ${b}`}`);
  if (a !== b) fallas++;
}
function titulo(msg: string) {
  log(`\n[${msg}]`);
}

const VERDE = { r: 0, g: 200, b: 0 };
const BLANCO = { r: 255, g: 255, b: 255 };

/** Fondo blanco con un cuadrado verde: el «logo» en la posición donde la marca lo pega. */
async function conCuadrado(w: number, h: number, x: number, y: number, lado: number): Promise<Buffer> {
  const cuadrado = await sharp({ create: { width: lado, height: lado, channels: 3, background: VERDE } })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: BLANCO } })
    .composite([{ input: cuadrado, left: x, top: y }])
    .png()
    .toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const esColor = (px: number[], c: { r: number; g: number; b: number }) =>
  Math.abs(px[0] - c.r) <= 3 && Math.abs(px[1] - c.g) <= 3 && Math.abs(px[2] - c.b) <= 3;

// Datos de ejemplo inventados: nada de esto es la marca real.
const marca: BrandConfig = {
  id: 'marca-de-prueba',
  name: 'Marca Prueba',
  logo_storage_path: 'no-se-usa.png',
  logo_position: 'top-left',
  logo_margin_px: 40,
  logo_size_px: 200,
  primary_color: '#112233',
  secondary_color: '#445566',
  accent_color: '#778899',
  typography: 'Montserrat',
  typography_title: '',
  typography_subtitle: '',
  typography_subsubtitle: '',
  prompt_guidelines: '',
  apply_logo_overlay: true,
  apply_to_shot_types: ['lifestyle'],
};

/** Lo que contesta el modelo cuando todo está bien; `parche` cambia campos. */
function respuestaModelo(parche: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text_readability: 5,
    weakest_text: 'ninguno',
    brand_match: 5,
    brand_mismatch: 'ninguno',
    logo_readability: 5,
    logo_problem: 'ninguno',
    logo_covers_content: false,
    ...parche,
  });
}

/** Respuesta de la API de Gemini con tokens como los informa 2.5: total = entrada + salida + razonamiento. */
function respuestaGemini(texto: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: texto }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1600, candidatesTokenCount: 300, totalTokenCount: 2700 },
      modelVersion: 'gemini-2.5-flash',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const nota = (parche: Partial<ParsedBrandReview> = {}): ParsedBrandReview => ({
  text_readability: 5,
  weakest_text: 'ninguno',
  brand_match: 5,
  brand_mismatch: 'ninguno',
  logo_readability: 5,
  logo_problem: 'ninguno',
  logo_covers_content: false,
  ...parche,
});

const revision = (verdict: BrandReview['verdict'], summary: string): BrandReview => ({
  verdict,
  problems: [],
  summary,
  model: 'gemini-2.5-flash',
  durationMs: 1,
  inputTokens: null,
  outputTokens: null,
  answer: null,
});

(async () => {
  const {
    sinClave,
    describeBrandFonts,
    buildBrandReviewPrompt,
    parseBrandReview,
    decideBrandReview,
    cropLogoZone,
    reviewBrandPass,
    brandPassOutcome,
  } = await import('../src/lib/brand-reviewer');

  // ── sinClave ──────────────────────────────────────────────────────────────────────────────
  titulo('sinClave — la clave de la URL no llega a la base ni a la pantalla');
  igual(
    sinClave('fallo https://h/m:generateContent?key=ABC123&alt=json por red'),
    'fallo https://h/m:generateContent?key=<redactado>&alt=json por red',
    'tapa la clave y respeta lo que sigue',
  );
  igual(sinClave('url ?KEY=xyz'), 'url ?key=<redactado>', 'tapa también con mayúsculas');
  igual(sinClave('(https://h?key=ABC) listo'), '(https://h?key=<redactado>) listo', 'se detiene en el paréntesis');
  igual(sinClave('sin nada que tapar'), 'sin nada que tapar', 'un texto sin clave queda igual');

  // ── describeBrandFonts ────────────────────────────────────────────────────────────────────
  titulo('describeBrandFonts');
  const tipos = { typography: 'Montserrat', typography_title: '', typography_subtitle: '', typography_subsubtitle: '' };
  igual(describeBrandFonts(tipos), 'Montserrat', 'sin tipografía por rol: la única de la marca');
  igual(describeBrandFonts({ ...tipos, typography: '  ' }), 'not specified', 'sin ninguna: not specified');
  igual(
    describeBrandFonts({ ...tipos, typography_title: 'Playfair', typography_subsubtitle: 'Lato' }),
    'titles: Playfair | body and features: Lato',
    'con roles: sólo los que hay (y la única se ignora)',
  );
  igual(describeBrandFonts({ ...tipos, typography_title: ' Play\nfair ' }), 'titles: Play fair', 'espacios y saltos colapsados');

  // ── buildBrandReviewPrompt ────────────────────────────────────────────────────────────────
  titulo('buildBrandReviewPrompt');
  const conLogo = buildBrandReviewPrompt({ ...marca, prompt_guidelines: 'Nunca usar rojo.' }, { textChanged: true, hasLogo: true });
  afirmar(conLogo.includes('IMAGE 3 is a ZOOM of the top-left corner'), 'con logo: describe la imagen 3 (el recorte)');
  afirmar(conLogo.includes('pasted the brand logo in the top-left corner'), 'con logo: dice en qué esquina se pegó');
  afirmar(conLogo.includes('recolored and re-fonted'), 'con texto cambiado: lo dice');
  afirmar(conLogo.includes('C. logo_readability — Look at Image 3'), 'con logo: pide la nota del logo sobre el recorte');
  afirmar(conLogo.includes('brand "Marca Prueba"'), 'lleva el nombre de la marca');
  afirmar(conLogo.includes('#112233') && conLogo.includes('#445566') && conLogo.includes('#778899'), 'lleva los tres colores');
  afirmar(conLogo.includes('Fonts: Montserrat'), 'lleva la tipografía');
  afirmar(conLogo.includes('Extra rules: Nunca usar rojo.'), 'lleva las reglas extra de la marca');
  afirmar(conLogo.includes('Respond ONLY with valid JSON'), 'pide sólo JSON');

  const sinLogo = buildBrandReviewPrompt(marca, { textChanged: false, hasLogo: false });
  afirmar(!sinLogo.includes('IMAGE 3'), 'sin logo: no hay imagen 3');
  afirmar(!sinLogo.includes('pasted the brand logo'), 'sin logo: no dice que se pegó uno');
  afirmar(sinLogo.includes('There is no logo in this run. Answer null.'), 'sin logo: la nota del logo es null');
  afirmar(sinLogo.includes('Not applicable in this run'), 'texto sin cambiar: brand_match no aplica');
  afirmar(sinLogo.includes('Its text was left as it was'), 'texto sin cambiar: lo dice');
  afirmar(!sinLogo.includes('recolored'), 'texto sin cambiar: no dice que se recoloreó');
  afirmar(!sinLogo.includes('Extra rules'), 'sin reglas extra: no deja la línea vacía');

  afirmar(
    buildBrandReviewPrompt({ ...marca, logo_position: 'bottom-right' }, { textChanged: true, hasLogo: true }).includes(
      'ZOOM of the bottom-right corner',
    ),
    'respeta la esquina de la marca',
  );
  afirmar(
    buildBrandReviewPrompt({ ...marca, primary_color: '' }, { textChanged: true, hasLogo: true }).includes(
      'Title color: not specified',
    ),
    'color vacío: not specified',
  );
  const largo = buildBrandReviewPrompt({ ...marca, prompt_guidelines: 'x'.repeat(2000) }, { textChanged: true, hasLogo: true });
  afirmar(largo.includes('x'.repeat(800)) && !largo.includes('x'.repeat(801)), 'las reglas extra se cortan en 800 caracteres');

  // ── parseBrandReview ──────────────────────────────────────────────────────────────────────
  titulo('parseBrandReview — leer la respuesta del modelo');
  igual(
    parseBrandReview(respuestaModelo()),
    {
      text_readability: 5,
      weakest_text: 'ninguno',
      brand_match: 5,
      brand_mismatch: 'ninguno',
      logo_readability: 5,
      logo_problem: 'ninguno',
      logo_covers_content: false,
    },
    'respuesta válida',
  );
  igual(
    parseBrandReview('Aquí va:\n```json\n' + respuestaModelo({ text_readability: 4 }) + '\n```\nListo.')?.text_readability,
    4,
    'tolera ```json y texto alrededor',
  );
  const nulas = parseBrandReview(respuestaModelo({ text_readability: null, logo_readability: null, brand_match: null }));
  igual([nulas?.text_readability, nulas?.logo_readability, nulas?.brand_match], [null, null, null], 'null = no aplica');
  igual(parseBrandReview(respuestaModelo({ text_readability: '4' }))?.text_readability, 4, 'nota como texto "4"');
  igual(parseBrandReview(respuestaModelo({ text_readability: '4.0' }))?.text_readability, 4, 'nota como texto "4.0"');
  for (const mala of [0, 6, -1, 3.5, '4.5', 'alto', true]) {
    igual(parseBrandReview(respuestaModelo({ text_readability: mala })), null, `texto = ${JSON.stringify(mala)}: no sirve`);
  }
  for (const mala of [0, 6, 2.5, 'n/a']) {
    igual(parseBrandReview(respuestaModelo({ logo_readability: mala })), null, `logo = ${JSON.stringify(mala)}: no sirve`);
  }
  const sinTapa = JSON.parse(respuestaModelo());
  delete sinTapa.logo_covers_content;
  igual(parseBrandReview(JSON.stringify(sinTapa)), null, 'sin logo_covers_content: no sirve');
  igual(parseBrandReview(respuestaModelo({ logo_covers_content: 'false' })), null, 'logo_covers_content como texto: no sirve');
  igual(parseBrandReview(respuestaModelo({ logo_covers_content: true }))?.logo_covers_content, true, 'logo_covers_content true');
  // brand_match no decide: roto o ausente NO tira una respuesta cuyo veredicto es usable.
  const sinMarca = JSON.parse(respuestaModelo());
  delete sinMarca.brand_match;
  igual(parseBrandReview(JSON.stringify(sinMarca))?.brand_match, null, 'brand_match ausente: null y la respuesta sirve');
  igual(parseBrandReview(respuestaModelo({ brand_match: 7 }))?.brand_match, null, 'brand_match fuera de rango: null y la respuesta sirve');
  igual(parseBrandReview(respuestaModelo({ brand_match: 'n/a' }))?.brand_match, null, 'brand_match "n/a": null y la respuesta sirve');
  for (const basura of ['no puedo ayudar con eso', '', '}{', '{ roto', 'null', '{"a":1}', '[1,2]']) {
    igual(parseBrandReview(basura), null, `no es la respuesta esperada: ${JSON.stringify(basura)}`);
  }
  igual(parseBrandReview(respuestaModelo({ weakest_text: 5 }))?.weakest_text, '', 'texto libre que no es string: vacío');
  igual(
    parseBrandReview(respuestaModelo({ weakest_text: '  mucho   espacio\nroto ' }))?.weakest_text,
    'mucho espacio roto',
    'texto libre con espacios colapsados',
  );

  // ── decideBrandReview ─────────────────────────────────────────────────────────────────────
  titulo('decideBrandReview — la regla (1 y 2 fallan, 3 pasa)');
  const conL = { hasLogo: true };
  const sana = decideBrandReview(nota(), conL);
  igual([sana.verdict, sana.problems, sana.summary], ['ok', [], 'Sin problemas graves'], 'todo 5: ok');

  igual(decideBrandReview(nota({ text_readability: 3 }), conL).verdict, 'ok', 'texto 3: pasa');
  igual(decideBrandReview(nota({ text_readability: 2 }), conL).verdict, 'fail', 'texto 2: falla');
  igual(decideBrandReview(nota({ text_readability: 1 }), conL).verdict, 'fail', 'texto 1: falla');
  igual(decideBrandReview(nota({ text_readability: null }), conL).verdict, 'ok', 'texto null (la imagen no tiene texto): pasa');

  igual(decideBrandReview(nota({ logo_readability: 3 }), conL).verdict, 'ok', 'logo 3: pasa');
  igual(decideBrandReview(nota({ logo_readability: 2 }), conL).verdict, 'fail', 'logo 2: falla');
  igual(decideBrandReview(nota({ logo_readability: 1 }), conL).verdict, 'fail', 'logo 1: falla');
  igual(decideBrandReview(nota({ logo_readability: null }), conL).verdict, 'ok', 'logo null: pasa');

  const tapa = decideBrandReview(nota({ logo_covers_content: true, logo_problem: 'tapa el precio' }), conL);
  igual(
    [tapa.verdict, tapa.problems],
    ['fail', ['Logo tapa contenido o se pierde: tapa el precio']],
    'logo que tapa contenido: falla y dice qué tapa',
  );
  igual(
    decideBrandReview(nota({ logo_covers_content: true }), conL).problems,
    ['Logo tapa contenido o se pierde: esconde texto o producto'],
    'logo que tapa, sin detalle: motivo por defecto',
  );
  igual(
    decideBrandReview(nota({ logo_covers_content: true, logo_readability: 1 }), conL).problems.length,
    1,
    'el logo no se cuenta dos veces (tapa + poco legible)',
  );

  const dos = decideBrandReview(nota({ text_readability: 2, logo_readability: 2 }), conL);
  igual(dos.problems.length, 2, 'texto y logo malos: dos motivos');
  afirmar(dos.summary.includes(' · '), 'el resumen une los motivos con " · "');

  igual(
    decideBrandReview(nota({ logo_readability: 1, logo_covers_content: true }), { hasLogo: false }).verdict,
    'ok',
    'sin logo pegado: el logo y «tapa» se ignoran',
  );
  igual(decideBrandReview(nota({ text_readability: 2 }), { hasLogo: false }).verdict, 'fail', 'sin logo pegado: el texto sigue contando');

  igual(
    decideBrandReview(nota({ brand_match: 1, brand_mismatch: 'título rojo' }), conL).verdict,
    'ok',
    'brand_match 1 NO falla (se registra, no decide)',
  );

  igual(
    decideBrandReview(nota({ text_readability: 2, weakest_text: 'ninguno' }), conL).problems,
    ['Texto difícil de leer (2/5): no se distingue bien'],
    'motivo «ninguno»: usa el de por defecto',
  );
  igual(
    decideBrandReview(nota({ text_readability: 2, weakest_text: 'Ninguno.' }), conL).problems,
    ['Texto difícil de leer (2/5): no se distingue bien'],
    'motivo «Ninguno.»: usa el de por defecto',
  );
  igual(
    decideBrandReview(nota({ text_readability: 2, weakest_text: '' }), conL).problems,
    ['Texto difícil de leer (2/5): no se distingue bien'],
    'motivo vacío: usa el de por defecto',
  );
  igual(
    decideBrandReview(nota({ text_readability: 2, weakest_text: 'Precio dorado sobre crema.' }), conL).problems,
    ['Texto difícil de leer (2/5): Precio dorado sobre crema'],
    'motivo real: se conserva (sin el punto final)',
  );
  igual(
    decideBrandReview(nota({ text_readability: 2, weakest_text: 'a'.repeat(1000) }), conL).summary.length,
    400,
    'el resumen se corta en 400 caracteres',
  );

  // ── cropLogoZone ──────────────────────────────────────────────────────────────────────────
  titulo('cropLogoZone — el recorte ampliado de la esquina del logo');
  // Logo de 200 px con margen de 40: el recorte toma la caja más el margen (280 px) y la lleva a 840.
  async function revisarZona(nombre: string, buf: Buffer, brand: BrandConfig) {
    const zona = await cropLogoZone(buf, brand);
    const m = await sharp(zona).metadata();
    igual([m.width, m.height], [840, 840], `${nombre}: recorte de 840×840`);
    afirmar(esColor(await pixel(zona, 420, 420), VERDE), `${nombre}: el centro es el logo`);
    afirmar(esColor(await pixel(zona, 60, 60), BLANCO), `${nombre}: el margen de arriba-izquierda es fondo`);
    afirmar(esColor(await pixel(zona, 780, 780), BLANCO), `${nombre}: el margen de abajo-derecha es fondo`);
  }
  await revisarZona('arriba-izquierda 1200×1200', await conCuadrado(1200, 1200, 40, 40, 200), marca);
  await revisarZona(
    'abajo-derecha 1200×1200',
    await conCuadrado(1200, 1200, 960, 960, 200),
    { ...marca, logo_position: 'bottom-right' },
  );
  await revisarZona(
    'abajo-izquierda 1200×900',
    await conCuadrado(1200, 900, 40, 660, 200),
    { ...marca, logo_position: 'bottom-left' },
  );
  await revisarZona(
    'arriba-derecha 1200×900',
    await conCuadrado(1200, 900, 960, 40, 200),
    { ...marca, logo_position: 'top-right' },
  );
  // Imagen más chica que la caja + margen: el recorte se acota a la imagen y no revienta.
  const chica = await cropLogoZone(await conCuadrado(300, 300, 100, 100, 200), { ...marca, logo_margin_px: 100 });
  const mChica = await sharp(chica).metadata();
  igual([mChica.width, mChica.height], [840, 840], 'imagen chica: recorte acotado, 840×840');
  afirmar(esColor(await pixel(chica, 420, 420), VERDE), 'imagen chica: el centro es el logo');
  afirmar(esColor(await pixel(chica, 30, 30), BLANCO), 'imagen chica: la esquina es fondo');

  // ── reviewBrandPass ───────────────────────────────────────────────────────────────────────
  titulo('reviewBrandPass — contra un fetch falso');
  const antes = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#cccccc' } }).png().toBuffer();
  const despues = await conCuadrado(1200, 1200, 40, 40, 200);
  const entrada = { beforeBuffer: antes, afterBuffer: despues, brand: marca, textChanged: true, hasLogo: true };

  // Bien, con logo.
  llamadas.length = 0;
  responder = async () => respuestaGemini(respuestaModelo());
  const ok = await reviewBrandPass(entrada);
  igual(ok.verdict, 'ok', 'respuesta buena: ok');
  igual(llamadas.length, 1, 'una sola llamada');
  const c = llamadas[0];
  afirmar(c.url.includes('/gemini-2.5-flash:generateContent'), 'revisa con gemini-2.5-flash');
  igual(c.temperatura, 0, 'temperatura 0');
  const imgs = c.partes.filter((p) => p.inline_data);
  igual(imgs.length, 3, 'con logo: manda 3 imágenes (antes, después, recorte)');
  igual(c.partes[c.partes.length - 1].text, buildBrandReviewPrompt(marca, { textChanged: true, hasLogo: true }), 'el texto es el prompt calibrado');
  const mAntes = await sharp(Buffer.from(imgs[0].inline_data!.data, 'base64')).metadata();
  igual([mAntes.width, mAntes.height], [1200, 1200], 'la imagen de antes se normaliza a 1200×1200');
  igual(imgs[1].inline_data!.data, despues.toString('base64'), 'la imagen de después va tal cual (lo que se aprobaría)');
  igual((await sharp(Buffer.from(imgs[2].inline_data!.data, 'base64')).metadata()).width, 840, 'el recorte va a 840 px de ancho');
  igual([ok.inputTokens, ok.outputTokens], [1600, 1100], 'tokens: entrada y salida = total − entrada (cuenta el razonamiento)');
  igual(ok.model, 'gemini-2.5-flash', 'informa el modelo que contestó');
  igual(ok.answer?.text_readability, 5, 'guarda lo que contestó el modelo');

  // Sin logo pegado.
  llamadas.length = 0;
  responder = async () => respuestaGemini(respuestaModelo({ logo_readability: null }));
  await reviewBrandPass({ ...entrada, hasLogo: false });
  igual(llamadas[0].partes.filter((p) => p.inline_data).length, 2, 'sin logo: manda 2 imágenes');
  afirmar(!llamadas[0].partes[llamadas[0].partes.length - 1].text!.includes('IMAGE 3'), 'sin logo: el prompt no habla de imagen 3');

  // Mal.
  responder = async () => respuestaGemini(respuestaModelo({ text_readability: 2, weakest_text: 'Precio dorado sobre crema' }));
  const mal = await reviewBrandPass(entrada);
  igual(mal.verdict, 'fail', 'texto 2: fail');
  afirmar(mal.summary.startsWith('Texto difícil de leer (2/5): Precio dorado'), 'el resumen dice qué falló');

  // Error HTTP.
  llamadas.length = 0;
  responder = async () => new Response('{}', { status: 500 });
  const http = await reviewBrandPass(entrada);
  igual(http.verdict, 'unavailable', 'HTTP 500: unavailable (no inventa un veredicto)');
  afirmar(http.summary.includes('HTTP 500'), 'HTTP 500: el resumen dice por qué');
  igual([http.answer, llamadas.length], [null, 1], 'HTTP 500: sin respuesta y sin reintento');

  // Respuesta sin texto.
  responder = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });
  const vacia = await reviewBrandPass(entrada);
  igual(vacia.verdict, 'unavailable', 'respuesta sin texto: unavailable');

  // Texto que no es JSON (los tokens se conservan: se gastaron).
  responder = async () => respuestaGemini('No puedo evaluar esta imagen.');
  const noJson = await reviewBrandPass(entrada);
  igual(noJson.verdict, 'unavailable', 'texto que no es JSON: unavailable');
  igual(noJson.summary, 'la respuesta del modelo no se pudo leer', 'texto que no es JSON: motivo claro');
  igual([noJson.inputTokens, noJson.answer], [1600, null], 'texto que no es JSON: conserva los tokens gastados');

  // JSON al que le falta un campo que decide.
  const incompleto = JSON.parse(respuestaModelo());
  delete incompleto.logo_covers_content;
  responder = async () => respuestaGemini(JSON.stringify(incompleto));
  igual((await reviewBrandPass(entrada)).verdict, 'unavailable', 'JSON incompleto: unavailable (ni pasa ni falla)');

  // Sin metadatos de uso: tokens null, el modelo cae al que se pidió.
  responder = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: respuestaModelo() }] } }] }), { status: 200 });
  const sinUso = await reviewBrandPass(entrada);
  igual([sinUso.verdict, sinUso.inputTokens, sinUso.outputTokens, sinUso.model], ['ok', null, null, 'gemini-2.5-flash'], 'sin usageMetadata: tokens null, sin NaN');

  // Error de red cuyo mensaje trae la URL con la clave. «retry in 0.01» acorta la espera interna.
  llamadas.length = 0;
  escritoPorElModulo.length = 0;
  responder = async () => {
    throw new Error(`https://h/v1beta/models/m:generateContent?key=${CLAVE} falló, retry in 0.01s`);
  };
  const red = await reviewBrandPass(entrada);
  igual(red.verdict, 'unavailable', 'error de red: unavailable');
  igual(llamadas.length, 2, 'error de red: a lo más 2 intentos (maxRetries 1)');
  afirmar(red.summary.includes('key=<redactado>'), 'error de red: la clave quedó tapada (control: sí había clave que tapar)');
  afirmar(!red.summary.includes(CLAVE), 'error de red: la clave NO está en el resumen que va a la base');
  const lineasDelRevisor = escritoPorElModulo.filter((l) => l.startsWith('[brand-review]'));
  afirmar(lineasDelRevisor.length > 0, 'error de red: el revisor dejó rastro en el log (control)');
  afirmar(lineasDelRevisor.every((l) => !l.includes(CLAVE)), 'error de red: la clave NO está en los logs del revisor');

  // Algo que revienta dentro del revisor (imagen que no es imagen): no lanza.
  llamadas.length = 0;
  const rota = await reviewBrandPass({ ...entrada, beforeBuffer: Buffer.from('no es una imagen') });
  igual(rota.verdict, 'unavailable', 'imagen ilegible: unavailable, no lanza');
  afirmar(rota.summary.startsWith('error al revisar'), 'imagen ilegible: el resumen lo dice');
  igual(llamadas.length, 0, 'imagen ilegible: no llega a llamar al modelo');

  // El modelo no contesta: se corta a los timeoutMs.
  responder = () => new Promise<Response>(() => {});
  const lenta = await reviewBrandPass({ ...entrada, timeoutMs: 50 });
  igual(lenta.verdict, 'unavailable', 'sin respuesta a tiempo: unavailable');
  igual(lenta.summary, 'el modelo no respondió a tiempo', 'sin respuesta a tiempo: motivo claro');
  afirmar(lenta.durationMs < 5000, 'sin respuesta a tiempo: volvió enseguida, no esperó al modelo');

  // ── brandPassOutcome ──────────────────────────────────────────────────────────────────────
  titulo('brandPassOutcome — lo que se escribe en la fila del trabajo');
  igual(
    brandPassOutcome(revision('fail', 'Texto difícil de leer (2/5): precio'), true),
    { status: 'flagged', qa_score: null, qa_feedback: 'Revisión de marca: Texto difícil de leer (2/5): precio' },
    'fail: flagged, sin qa_score, con el motivo',
  );
  igual(
    brandPassOutcome(revision('fail', 'x'), false).status,
    'flagged',
    'fail con el respaldo de sharp: también flagged',
  );
  igual(
    brandPassOutcome(revision('unavailable', 'el modelo no respondió a tiempo'), true),
    {
      status: 'approved',
      qa_score: 0.95,
      qa_feedback: 'Auto-approved (BRAND_ONLY Gemini) — SIN revisión de marca: el modelo no respondió a tiempo',
    },
    'unavailable: se aprueba como siempre, pero dice que NO se revisó',
  );
  igual(
    brandPassOutcome(revision('unavailable', 'x'), false).qa_feedback,
    'Auto-approved (BRAND_ONLY Sharp fallback) — SIN revisión de marca: x',
    'unavailable con el respaldo de sharp: lo dice',
  );
  igual(
    brandPassOutcome(revision('ok', 'Sin problemas graves'), true),
    { status: 'approved', qa_score: 0.95, qa_feedback: 'Aprobada (BRAND_ONLY Gemini) · revisión de marca: sin problemas graves' },
    'ok: aprobada y dice que se revisó',
  );
  igual(
    brandPassOutcome(null, true),
    { status: 'approved', qa_score: 0.95, qa_feedback: 'Auto-approved (BRAND_ONLY Gemini)' },
    'sin revisión (la marca no existe): como siempre',
  );

  log(fallas === 0 ? '\nTodo OK' : `\n${fallas} falla(s)`);
  process.exit(fallas === 0 ? 0 : 1);
})().catch((err) => {
  log('\nFALLA: la prueba reventó:', err);
  process.exit(1);
});

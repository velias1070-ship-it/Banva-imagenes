/**
 * Espía sobre el camino real (generateImageSmart → adapter OpenAI → fetch):
 * qué instrucción y qué muestra le llegan a ChatGPT por categoría.
 *
 * - toallas: la instrucción corta SOLA y la muestra COMPLETA (no el recorte).
 * - toallas sin muestra completa: cae a la recortada (no rompe llamadas viejas).
 * - sabanas: sigue su instrucción corta.
 * - el resto: la instrucción de siempre + el armador, con la muestra recortada.
 *
 * Uso: npx tsx scripts/test-toallas-chatgpt.ts  (no llama a ninguna API)
 */
process.env.OPENAI_API_KEY ||= 'sk-test';
process.env.GEMINI_API_KEY ||= 'test';

const RECORTADA = Buffer.from('muestra-recortada').toString('base64');
const COMPLETA = Buffer.from('muestra-completa').toString('base64');

type Captura = { prompt: string; muestra: string };
let captura: Captura | null = null;

globalThis.fetch = (async (_url: unknown, init?: { body?: FormData }) => {
  const form = init!.body as FormData;
  const imagenes = form.getAll('image[]') as Blob[];
  captura = {
    prompt: String(form.get('prompt')),
    muestra: Buffer.from(await imagenes[1].arrayBuffer()).toString('utf8'),
  };
  return new Response(JSON.stringify({ data: [{ b64_json: 'aW1n' }] }), { status: 200 });
}) as typeof fetch;

let fallas = 0;
function afirmar(cond: boolean, msg: string) {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}`);
  if (!cond) fallas++;
}

async function correr(category: string, conCompleta: boolean): Promise<Captura> {
  const { generateImageSmart } = await import('../src/lib/image-providers');
  captura = null;
  const r = await generateImageSmart(
    {
      heroImageBase64: Buffer.from('hero').toString('base64'),
      heroMimeType: 'image/png',
      swatchImageBase64: RECORTADA,
      swatchMimeType: 'image/png',
      swatchCompletaBase64: conCompleta ? COMPLETA : undefined,
      promptText: 'ARMADOR: UNA SOLA tela uniforme',
    },
    { category, attempt: 0, swatchProfile: null },
  );
  if (r.providerUsed !== 'gpt-image-2' || !captura) throw new Error(`${category}: no fue a ChatGPT (${r.providerUsed})`);
  return captura;
}

(async () => {
  const toallas = await correr('toallas', true);
  afirmar(toallas.prompt.startsWith('Image 1 is a product photo of a towel set.'), 'toallas: instrucción corta de toallas');
  afirmar(!toallas.prompt.includes('ARMADOR'), 'toallas: sin el armador');
  afirmar(toallas.muestra === 'muestra-completa', 'toallas: muestra completa');

  const toallasSin = await correr('toallas', false);
  afirmar(toallasSin.muestra === 'muestra-recortada', 'toallas sin muestra completa: cae a la recortada');

  const sabanas = await correr('sabanas', true);
  afirmar(sabanas.prompt.startsWith('Image 1 is a product photo of a bed sheet set.'), 'sabanas: su instrucción corta');
  afirmar(sabanas.muestra === 'muestra-recortada', 'sabanas: muestra recortada (sin cambios)');

  const cortinas = await correr('cortinas', true);
  afirmar(cortinas.prompt.includes('ARMADOR'), 'cortinas: sigue con el armador (sin cambios)');
  afirmar(cortinas.muestra === 'muestra-recortada', 'cortinas: muestra recortada (sin cambios)');

  console.log(fallas === 0 ? '\nTodo OK' : `\n${fallas} falla(s)`);
  process.exit(fallas === 0 ? 0 : 1);
})();

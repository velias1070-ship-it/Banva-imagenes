// ─────────────────────────────────────────────────────────────────────────────
// Category Strategy Config — Single source of truth for all category behavior
// ─────────────────────────────────────────────────────────────────────────────
// Adding a new category = adding ONE entry here. Zero route code changes.
// ─────────────────────────────────────────────────────────────────────────────

export type GenerationMode = 'edit' | 'reference' | 'from_scratch';

export interface CategoryStrategy {
  key: string;
  label: string;
  generation_mode: GenerationMode;
  retry_escalation?: GenerationMode;
  preprocessing: {
    crop_swatch: boolean;
    flatten_hero: boolean;
    flatten_swatch_ai?: boolean;
    /**
     * When true, tile the cropped swatch 2x2 before sending to Gemini.
     * Use for categories where the product set includes small fabric
     * surfaces (pillowcases) that would otherwise show white background
     * from the swatch pattern's negative space. Only enable for categories
     * where the swatch is typically a photo of a bedroom scene or full
     * product where motifs are spread across a large area. DO NOT enable
     * for categories where the swatch is already a close-up fabric shot
     * (towels, curtains) — tiling would miniaturize an already-dense pattern.
     */
    tile_swatch?: boolean;
  };
  prompt: {
    product_context: string;
    what_to_change: string;
    /** Shot-type-aware instruction for detail/infografia shots where fabric form must be preserved */
    what_to_change_detail?: string;
    final_check: string;
    dark_swatch_note: string;
  };
  reference_instruction?: string;
  shot_compositions: Record<string, string>;
  temperature?: number;
  qa_focus_areas?: string[];
  /** Accumulated learnings from past failures — injected into BOTH generation prompts AND QA scoring */
  learnings?: string[];
  /**
   * Surfaces the swatch design MUST apply to. Phrased in Spanish for Gemini.
   * Used by buildReferencePrompt to constrain pattern bleed to only these surfaces.
   * e.g. alfombras: ['alfombras y tapetes visibles'].
   * e.g. quilts: ['cobertor principal', 'fundas de almohada del set'].
   */
  target_surfaces?: string[];
  /**
   * Surfaces that MUST stay identical to Image 1 (no color/pattern change).
   * Explicit negative list to prevent Gemini from repainting non-product textiles.
   * e.g. alfombras: ['sofá/tapicería', 'sábanas/fundas de cama', 'cortinas', 'cojines', 'otros textiles de la escena'].
   */
  preserve_surfaces?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 15 categories + _default
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_STRATEGIES: Record<string, CategoryStrategy> = {
  quilts: {
    key: 'quilts',
    label: 'Quilts',
    // Hybrid: edit by default (preserve hero scene literally), escalate to
    // reference only when QA detects hero contamination > 0.6 on retry.
    // Edit mode works for most quilts (flat printed patterns + waffle/light
    // textures). Reference mode only kicks in when stitching 3D conflicts
    // (e.g., hero has mandala stitching, swatch has basket weave) and Gemini
    // can't replace the embossed pattern, leaving hero stitching bleeding through.
    generation_mode: 'edit',
    // Stay in edit mode on verifier retries — reference mode loses the hero's exact
    // composition. The verifier typically rejects for fabric fidelity, not composition,
    // and retrying in edit mode with Pro + feedback usually succeeds. Reference mode
    // only triggers via QA's hero_contamination escalation logic (when fabric bleeds
    // through edit mode).
    retry_escalation: 'edit',
    // flatten_hero: false — previously true with blur 5.0 + contrast reduce,
    // but that destroyed facial features and Gemini had to regenerate faces
    // from scratch (job 1d841d62: model's face changed every regen). Waffle
    // and channel stitching textures don't need flattening — Gemini handles
    // them fine when edit mode is used with the original hero. Flatten_hero
    // should only be used for deep 3D embossed quilting (mandala / basket
    // weave), which is a minority case; enable per-job via metadata when
    // explicitly needed, not as the default.
    preprocessing: { crop_swatch: true, flatten_hero: false, flatten_swatch_ai: false, tile_swatch: true },
    prompt: {
      product_context: `A quilt is a lightweight bed COVER (cobertor), NOT a sheet.
The quilt product set includes: the quilt itself (bed cover) + matching pillowcases.
There are NO sheets and NO fitted sheets in this product.`,

      what_to_change: `Cambia SOLO la tela del cobertor y fundas de almohada visibles al diseño de Imagen 2. Ignora el relieve o acolchado de Imagen 1.

REGLA DE PRODUCTO — CRÍTICA:
La imagen vende un PRODUCTO ESPECÍFICO. La cantidad de piezas del hero define el set:
  - Si Imagen 1 muestra 1 almohada → el set es "quilt + 1 funda". El resultado DEBE tener 1 almohada.
  - Si Imagen 1 muestra 2 almohadas → el set es "quilt + 2 fundas". El resultado DEBE tener 2 almohadas.
  - NO agregar almohadas extras — eso cambia el producto que se vende.
  - NO quitar almohadas — eso también cambia el producto.

DENSIDAD DEL PATRÓN EN LAS FUNDAS — REGLA CRÍTICA:
El swatch (Imagen 2) tiene un patrón con motivos (hojas, flores, formas) separados por espacio blanco de fondo. Cuando se aplica a una funda de almohada chica, NO copies el swatch literalmente como un "stamp" porque partes de la funda caerían en el espacio blanco del patrón y la funda quedaría con zonas blancas visibles.

En vez de eso, la funda debe mostrar el patrón con la MISMA densidad de motivos que el cobertor — si el cobertor tiene 5 hojas visibles por metro cuadrado, la funda también debe tener aproximadamente 5 hojas visibles por metro cuadrado. Escalá el patrón (repetilo más chico si hace falta) para que CADA funda muestre al menos 3-5 motivos completos distribuidos, sin áreas grandes de fondo blanco sin decoración.

LO PROHIBIDO:
  - Funda con una mitad con patrón y otra mitad blanca → PRODUCTO DEFECTUOSO.
  - Funda mostrando solo el fondo blanco del swatch sin hojas/motivos.
  - Funda con un solo motivo pequeño en una esquina.

LO CORRECTO:
  - Funda cubierta UNIFORMEMENTE con hojas/motivos en toda su superficie visible.
  - Densidad similar a la del cobertor.

DIRECCIÓN DEL PATRÓN — REGLA CRÍTICA:
Si el swatch (Imagen 2) muestra un patrón con una DIRECCIÓN definida (rayas horizontales, rayas verticales, diagonales, chevron, etc.), el resultado DEBE reproducir ESA MISMA dirección.
  - Rayas HORIZONTALES en el swatch → rayas HORIZONTALES en el resultado. NO agregues líneas verticales cruzando, NO conviertas rayas horizontales en plaid/tartán/tejido cruzado.
  - Rayas VERTICALES en el swatch → rayas VERTICALES en el resultado. NO agregues horizontales.
  - Si el swatch muestra bandas simples (como un quilt de rayas), el resultado debe mostrar bandas simples — no un tejido con hilos cruzados.
  - La "textura de tela tejida" NO es una excusa para agregar líneas en direcciones que no están en el swatch.

CONSISTENCIA DE PATRÓN ENTRE PIEZAS DEL SET — REGLA CRÍTICA:
El cobertor (cubrecama), las fundas de almohada y el faldón lateral son TODAS PIEZAS DE LA MISMA ÚNICA TELA RAYADA. En un set real las rayas físicas atraviesan todas las piezas en la misma dirección anatómica (paralelas al borde del foot/headboard de la cama, perpendiculares a los rieles laterales).
  - Si las rayas del cobertor van paralelas al headboard (across the bed width) → las rayas de las fundas de almohada DEBEN ir en la MISMA dirección física (paralelas al headboard también). NO rotes las rayas 90° entre el cobertor y las fundas.
  - Las rayas del cobertor y las rayas de las fundas DEBEN ser visualmente continuas — si imaginariamente unieras una funda al borde del cobertor, las rayas seguirían en línea.
  - PROHIBIDO: cobertor con rayas horizontales en cámara + fundas con rayas verticales en cámara (o viceversa). Eso parecería dos telas distintas, no un set coordinado.
  - El faldón que cuelga sobre el borde lateral de la cama es la misma tela también — sus rayas deben envolver continuamente desde el plano superior del cobertor.

TODO lo demás queda IDÉNTICO a Imagen 1: muebles, lámpara, objetos de mesa de noche, alfombra, pared, cuadros, decoración.`,

      what_to_change_detail: `Apply the EXACT surface of Image 2 to ALL visible fabric surfaces in Image 1.

SINGLE FABRIC RULE — CRITICAL:
Image 1 shows a SINGLE piece of fabric viewed from different angles in a close-up shot.
Even if you see what looks like a fold, a corner held up, fabric laying flat behind, multiple layers, or different lighting on different parts — IT IS ALL THE SAME ONE PIECE OF FABRIC.
You MUST apply the swatch pattern UNIFORMLY to EVERY single visible fabric surface in the image:
  - The folded/held corner
  - The fabric behind the fold
  - The fabric laying flat
  - The fabric in shadow
  - The fabric in highlight
  - The reverse/back side if visible
ALL of these are the same fabric. ALL must show the same swatch pattern at the same density. Do NOT treat the background fabric as separate — it is the same piece.

PATTERN COVERAGE:
The pattern from Image 2 MUST cover EVERY square inch of visible fabric UNIFORMLY.
Do NOT leave any blank, white, or empty areas. Do NOT show waffle, dots, or channel stitching in any "background" area — that would mean you treated it as a different fabric.
If you see ANY fabric without the swatch pattern, you have failed.

SURFACE TYPE — match what the swatch (Image 2) actually shows:
  - If the swatch is a FLAT PRINTED pattern (floral, geometric print on smooth fabric) → make the result FLAT and smooth, NO quilting stitching, NO embossed texture, NO channels, NO dots. Only the printed pattern on flat fabric.
  - If the swatch shows visible QUILTING (channel stitching, diamond stitching, waffle, etc) → reproduce that exact quilting pattern.
  - DO NOT invent texture that is not present in Image 2.
  - DO NOT preserve any texture from Image 1 (the hero) — the hero's relief, waffle, channel stitching, etc must be COMPLETELY removed from EVERY area.

COMPOSITION — preserve from Image 1:
Maintain EXACTLY the same fabric folds, creases, draping, and disposition as Image 1.
The fabric shape, layers, and folding must be IDENTICAL to Image 1 — only the color/pattern/surface changes.
DO NOT change the fabric's physical form, folds, or arrangement.`,

      final_check: `Verifica: ¿el quilt tiene el diseño de la imagen 2 y NO el patrón original?`,

      dark_swatch_note: `La muestra es MUY OSCURA — el quilt generado debe ser igual de oscuro. No lo aclares.`,
    },
    reference_instruction: `Image 1 shows a REFERENCE COMPOSITION — use its camera angle, scene layout, and overall arrangement as a GUIDE for generating a NEW image.
Do NOT preserve Image 1's fabric texture or quilting pattern.
Generate a completely new textile surface using ONLY Image 2's fabric.
Image 1 is ONLY a composition guide — the product (color, pattern, texture) comes entirely from Image 2.`,
    shot_compositions: {
      lifestyle: `a lifestyle bedroom scene: a neatly made bed with the quilt/bedspread as the main product, 2 matching pillowcases on pillows, a simple neutral headboard, soft natural lighting from the side, a clean minimal nightstand with a small decorative item. The quilt should cover most of the bed with natural, gentle draping and folds. Shot from a slight angle (about 30-45 degrees) showing the full bed.`,
      detail: `a close-up detail shot: showing the quilt fabric texture and quilting stitch pattern up close. The fabric fills most of the frame with natural soft folds. Shallow depth of field, soft studio lighting from above. Only the quilt fabric is visible — no bed, no pillows, no room.`,
      main: `a product packshot: the quilt neatly folded and centered on a pure white background (#FFFFFF). The folded quilt shows the quilting stitch pattern clearly. Clean studio lighting, no shadows, no props. Professional e-commerce product photography style.`,
      doblada: `the quilt neatly folded on a clean white surface, showing the quilting pattern and fabric texture. Folded in thirds or quarters. Clean studio lighting with subtle soft shadow underneath. No background distractions.`,
      default: `a professional product photograph of a quilt/bedspread on a bed in a clean, well-lit bedroom. The quilt is the main subject, with matching pillowcases. Neutral, minimal decor. Soft natural lighting.`,
    },
    temperature: 0.4,
    qa_focus_areas: [
      'fabric surface must match swatch exactly — flat printed → flat, quilted → quilted',
      'no pattern from hero bleeding into output',
      'pillowcases must also match swatch pattern and color',
      'do NOT invent quilting texture if the swatch is a flat printed pattern',
      'any text in the image MUST be in Spanish — English text = ml_compliance 0.0',
    ],
    learnings: [
      'El quilt DEBE mostrar la MISMA superficie que el swatch (Imagen 2). Si el swatch es ESTAMPADO PRINTED PLANO (sin acolchado visible), el resultado debe ser plano sin acolchado. Si el swatch muestra acolchado (waffle, diamante, channels), el resultado debe replicar ese acolchado exacto. NO inventar acolchado que no existe en el swatch.',
      'Todo texto visible en la imagen DEBE estar en español. Nunca generar texto en inglés.',
      'El color base de la tela debe coincidir exactamente con el swatch — si el swatch es blanco, no generar crema/beige.',
      'No conservar NINGÚN relieve, textura ni patrón acolchado del hero original (imagen 1). La textura viene 100% del swatch.',
    ],
  },

  sabanas: {
    key: 'sabanas',
    label: 'Sabanas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a bed sheet set (juego de sabanas).
The set includes: pillowcases + flat/top sheet + fitted sheet (sabana bajera).`,

      what_to_change: `IMPORTANT — Image 2 may show DIFFERENT patterns for different pieces:
* The PILLOWCASES in Image 2 have one pattern (could be floral, striped, etc.)
* The FITTED SHEET (sabana bajera) in Image 2 may have a DIFFERENT pattern (often stripes or solid color)

Apply each pattern to the correct piece in Image 1:
* Pillowcases in Image 1 -> use the PILLOWCASE pattern from Image 2
* The flat surface underneath the pillows (fitted sheet) -> use the FITTED SHEET pattern from Image 2
* If a top sheet is visible in Image 1 -> use its corresponding pattern from Image 2

If Image 2 shows only ONE pattern for everything -> apply that same pattern to all textiles.
If you cannot clearly distinguish the fitted sheet pattern in Image 2 -> use the dominant background color/pattern visible beneath the pillows in Image 2.

IMPORTANT: Sheets (sabanas) are FLAT, thin fabric — they must lay SMOOTH and FLAT on the bed, just like in Image 1. DO NOT add volume, puffiness, or quilting. Sheets are NOT duvets/comforters.

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing`,

      what_to_change_detail: `Apply the color and pattern from Image 2 to ALL visible fabric surfaces.
Maintain EXACTLY the same fabric folds, creases, and disposition as Image 1.
Only change the color/pattern — the physical form of the fabric must be identical.`,

      final_check: `Before outputting, verify:
1. Do the PILLOWCASES match the pillowcase pattern from Image 2?
2. Does the FITTED SHEET match the fitted sheet pattern from Image 2? (NOT gray unless the swatch shows gray)
3. Did I invent any pattern not found in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. The output fabric color MUST be TRUE DARK — match the swatch's darkness exactly.
Do NOT lighten the fabric to make the pattern visible — dark fabric stays dark.`,
    },
    shot_compositions: {
      lifestyle: `a bedroom scene with the sheet set as the main product: pillowcases on pillows, fitted sheet visible, soft natural lighting.`,
      detail: `a close-up detail shot of the sheet fabric texture and pattern. Soft folds, clean lighting.`,
      main: `the sheet set neatly folded and centered on a pure white background. Professional e-commerce style.`,
      doblada: `the sheet set neatly folded and packaged on a clean white surface.`,
      default: `a professional product photo of a sheet set on a bed, well-lit, pillowcases and sheets visible.`,
    },
    qa_focus_areas: [
      'pillowcase pattern must match swatch pillowcase pattern',
      'fitted sheet pattern must match swatch fitted sheet pattern',
      'different patterns on different pieces preserved correctly',
    ],
  },

  cubrecamas: {
    key: 'cubrecamas',
    label: 'Cubrecamas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: true, flatten_hero: false, tile_swatch: true },
    prompt: {
      product_context: `This is a bedspread (cubrecama) — a decorative bed cover.
The product typically includes the bedspread itself, sometimes with matching pillow shams.`,

      what_to_change: `Change ALL textile surfaces of the bedspread product visible in Image 1:
* The BEDSPREAD itself -> apply the color and pattern from Image 2
* PILLOW SHAMS (if part of the product set) -> apply the matching pattern from Image 2

If Image 2 shows different patterns on different pieces, match each piece accordingly.

DO NOT change:
* The bed surface UNDERNEATH the bedspread
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing`,

      what_to_change_detail: `Apply the color and pattern from Image 2 to ALL visible fabric surfaces.
Maintain EXACTLY the same fabric folds, creases, and disposition as Image 1.
Only change the color/pattern — the physical form of the fabric must be identical.`,

      final_check: `Before outputting, verify:
1. Does the BEDSPREAD match the pattern/color from Image 2?
2. Do any PILLOW SHAMS match Image 2?
3. Did I invent any pattern not found in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. The output MUST match the darkness exactly.
Do NOT lighten the fabric. Texture should be subtle on dark surfaces.`,
    },
    shot_compositions: {
      lifestyle: `a bedroom scene with the bedspread as the main product, covering the bed. Matching pillow shams if applicable. Soft natural lighting.`,
      main: `the bedspread neatly folded on a pure white background. Professional e-commerce product photography.`,
      default: `a professional product photo of a bedspread on a bed, well-lit bedroom.`,
    },
    qa_focus_areas: [
      'bedspread pattern must match swatch exactly',
      'pillow shams must also match if part of the set',
    ],
  },

  plumones: {
    key: 'plumones',
    label: 'Plumones',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: true, flatten_hero: false, tile_swatch: true },
    prompt: {
      product_context: `This is a duvet/comforter (plumon) — a thick, puffy bed covering filled with down or synthetic fill.
The plumon typically has a quilted/channel stitch pattern to keep the fill distributed evenly.`,

      what_to_change: `Change the duvet/comforter textile surfaces visible in Image 1:
* The PLUMON/COMFORTER -> apply the color and pattern from Image 2
* Matching PILLOW SHAMS or PILLOWCASES -> apply the matching color from Image 2 if they are part of the product

Preserve the puffy, lofted appearance — plumones are thick and voluminous.

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing
* The bed underneath the plumon`,

      what_to_change_detail: `Apply the color and pattern from Image 2 to ALL visible fabric surfaces.
Maintain EXACTLY the same fabric folds, creases, and disposition as Image 1.
Only change the color/pattern — the physical form of the fabric must be identical.`,

      final_check: `Before outputting, verify:
1. Does the PLUMON color match Image 2?
2. Is the puffy/lofted appearance preserved?
3. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. The output plumon MUST match the darkness exactly. Do NOT lighten it.`,
    },
    shot_compositions: {
      lifestyle: `a bedroom scene with a puffy comforter/duvet on a bed. Lofted, voluminous appearance. Soft natural lighting.`,
      main: `the plumon/comforter folded on a pure white background, showing its puffy texture.`,
      default: `a professional product photo of a plumon/comforter on a bed.`,
    },
    qa_focus_areas: [
      'color must match swatch exactly',
      'puffy/lofted texture must be preserved',
    ],
  },

  frazadas: {
    key: 'frazadas',
    label: 'Frazadas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a blanket (frazada) — a warm, typically fleece or polar fabric bed covering.`,

      what_to_change: `Change ALL textile surfaces of the blanket visible in Image 1:
* The BLANKET -> apply the color and pattern from Image 2

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing`,

      final_check: `Before outputting, verify:
1. Does the BLANKET color/pattern match Image 2?
2. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      lifestyle: `a cozy scene with the blanket draped over a bed or sofa. Soft natural lighting.`,
      main: `the blanket folded on a pure white background.`,
      default: `a professional product photo of a blanket, showing its fabric texture.`,
    },
    qa_focus_areas: [
      'blanket color must match swatch',
      'fleece/polar texture preserved',
    ],
  },

  almohadas: {
    key: 'almohadas',
    label: 'Almohadas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a pillow product (almohada) — could be a bed pillow, decorative cushion, or body pillow.`,

      what_to_change: `Change ALL pillow/cushion textile surfaces visible in Image 1:
* PILLOWCASES / CUSHION COVERS -> apply the color and pattern from Image 2
* If multiple pillows are shown, ALL must match Image 2

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Persons, hands, or clothing
* The pillow's SHAPE and VOLUME (if firm, keep firm; if flat, keep flat)`,

      final_check: `Before outputting, verify:
1. Do ALL pillowcases/cushion covers match Image 2?
2. Are the pillow shapes and volumes preserved?
3. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      lifestyle: `pillows arranged on a bed or sofa in a well-lit room. Soft natural lighting.`,
      main: `a pillow centered on a pure white background. Clean studio lighting.`,
      default: `a professional product photo of pillows.`,
    },
    qa_focus_areas: [
      'all pillow covers must match swatch',
      'pillow shape and volume preserved',
    ],
  },

  toallas: {
    key: 'toallas',
    label: 'Toallas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: true, flatten_hero: false },
    target_surfaces: ['las toallas visibles (de baño, mano o rostro) del set mostrado'],
    preserve_surfaces: [
      'batas, alfombras de baño, cortinas de ducha',
      'cualquier otro textil, pared, mueble o elemento no-toalla',
    ],
    prompt: {
      product_context: `This is a towel product (toalla) — could be bath towel, hand towel, or towel set.`,

      what_to_change: `Esta es una operacion de CAMBIO DE COLOR UNICAMENTE. La imagen de salida debe ser IDENTICA a la Imagen 1 en todo excepto el color de las toallas.

Cambia SOLO el color de TODAS las toallas visibles en la Imagen 1 al color que muestra la Imagen 2.

La Imagen 2 es una REFERENCIA DE COLOR — puede ser una foto de producto completa. Extrae UNICAMENTE el color y textura de la tela. NO copies la composicion, fondo, etiquetas, ni ningun otro elemento de la Imagen 2.

DEBE SER IDENTICO a la Imagen 1:
* Misma cantidad de toallas, mismo orden, mismo apilado
* Misma etiqueta/tag (texto, posicion, angulo, cuerda)
* Mismo fondo (color, degradado, textura)
* Mismo angulo de camara y encuadre
* Mismos pliegues, dobleces y bordes de cada toalla

NO CAMBIAR NADA excepto el color de la tela de las toallas.
NO inventar fondo, props, escena ni composicion nueva.
NO agregar ni quitar elementos.`,

      what_to_change_detail: `Apply the color and pattern from Image 2 to ALL visible fabric surfaces.
Maintain EXACTLY the same fabric folds, creases, and disposition as Image 1.
Only change the color/pattern — the physical form of the fabric must be identical.`,

      final_check: `Before outputting, verify:
1. Do ALL towels match Image 2's COLOR (not composition)?
2. Is the terry cloth texture preserved?
3. Does the composition EXACTLY match Image 1 (same arrangement, labels, props)?
4. Did I copy any element from Image 2 that is NOT the fabric color? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      lifestyle: `towels displayed in a clean bathroom setting. Rolled or folded, with soft lighting.`,
      main: `towels neatly stacked/folded on a pure white background.`,
      default: `a professional product photo of towels.`,
    },
    qa_focus_areas: [
      'all towels must match swatch color',
      'terry cloth texture preserved',
    ],
  },

  manteles: {
    key: 'manteles',
    label: 'Manteles',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    target_surfaces: ['el mantel y las servilletas (si están visibles) del set'],
    preserve_surfaces: [
      'mesa, sillas, vajilla, cubertería, cristalería y decoración',
      'cualquier otro textil no-mantel (cortinas, paños, alfombras)',
    ],
    prompt: {
      product_context: `This is a tablecloth product (mantel) — could include a tablecloth, table runner, or napkins.`,

      what_to_change: `Change ALL tablecloth/textile surfaces visible in Image 1:
* The TABLECLOTH -> apply the color and pattern from Image 2
* NAPKINS (if part of the set) -> apply the matching pattern from Image 2

DO NOT change:
* Non-textile elements (table, chairs, dishes, cutlery, decor)
* The table underneath the tablecloth`,

      final_check: `Before outputting, verify:
1. Does the TABLECLOTH match Image 2?
2. Do NAPKINS (if present) match Image 2?
3. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      lifestyle: `a dining table set with the tablecloth as the main product. Table setting with simple props. Soft natural lighting.`,
      main: `the tablecloth folded on a pure white background.`,
      default: `a professional product photo of a tablecloth on a table.`,
    },
    qa_focus_areas: [
      'tablecloth pattern must match swatch exactly',
      'napkins must match if part of the set',
    ],
  },

  toppers: {
    key: 'toppers',
    label: 'Toppers',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a mattress topper — a padded mattress cover that adds comfort and protection.`,

      what_to_change: `Change the topper textile surfaces visible in Image 1:
* The TOPPER COVER -> apply the color and pattern from Image 2

Preserve the padded/quilted appearance of the topper — it has visible depth and cushioning.

DO NOT change:
* The mattress underneath the topper
* Non-textile elements (bed frame, furniture)`,

      final_check: `Before outputting, verify:
1. Does the TOPPER COVER match Image 2?
2. Is the padded appearance preserved?
3. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      main: `a mattress topper on a pure white background, showing its padded texture.`,
      detail: `a close-up of the topper's quilted/padded surface.`,
      default: `a professional product photo of a mattress topper.`,
    },
    qa_focus_areas: [
      'topper cover color must match swatch',
      'padded/quilted texture preserved',
    ],
  },

  alfombras: {
    key: 'alfombras',
    label: 'Alfombras',
    generation_mode: 'reference',
    retry_escalation: 'reference',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    target_surfaces: ['la alfombra / tapete visible en la escena'],
    preserve_surfaces: [
      'sofás, sillones y tapicería',
      'sábanas, fundas de cama, cubrecamas y cojines',
      'cortinas',
      'paredes, pisos no-alfombrados y muebles',
      'cualquier otro textil de la escena que no sea la alfombra',
    ],
    prompt: {
      product_context: `This is a rug/carpet product (alfombra) — could be area rug, runner, or mat.
Rugs have their OWN pattern/design that defines the product. The swatch IS the product design.`,

      what_to_change: `Change the rug/carpet visible in Image 1:
* The ENTIRE RUG -> apply the exact design, color, and pattern from Image 2
* Rug patterns are often intricate (geometric, floral, abstract) — reproduce them faithfully

CRITICAL: The rug design in Image 2 IS the product. Copy it EXACTLY — every motif, every color, every border detail.

DO NOT change:
* Floor surface around the rug
* Non-textile elements (furniture, props)
* Persons or pets`,

      final_check: `Before outputting, verify:
1. Does the RUG design match Image 2 EXACTLY?
2. Are all motifs, borders, and color zones faithful to Image 2?
3. Did I simplify or alter the rug pattern? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK rug. Match the darkness exactly. Pattern details may be subtle on dark rugs — this is correct.`,
    },
    reference_instruction: `Image 1 shows a REFERENCE COMPOSITION — use its camera angle, scene layout, and rug placement as a GUIDE.
Do NOT preserve Image 1's rug design. Generate a completely new rug using ONLY Image 2's design and colors.
Image 1 is ONLY a layout guide — the rug product comes entirely from Image 2.`,
    shot_compositions: {
      lifestyle: `a living room or bedroom with the rug as the main product on the floor. Furniture partially visible. Soft natural lighting.`,
      main: `the rug flat on a pure white background, showing the full design. Top-down view.`,
      detail: `a close-up of the rug's texture and pattern detail.`,
      default: `a professional product photo of a rug on a floor, showing its full design.`,
    },
    temperature: 0.3,
    qa_focus_areas: [
      'rug design must match swatch exactly — every motif and border',
      'colors must be faithful to swatch',
      'no pattern simplification or invention',
    ],
  },

  limpiapies: {
    key: 'limpiapies',
    label: 'Limpiapies / Choapino',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    target_surfaces: ['el limpiapies / choapino visible en la escena'],
    preserve_surfaces: [
      'piso, paredes, puertas y muebles',
      'cualquier otro textil (alfombras, toallas, cortinas, etc.)',
    ],
    prompt: {
      product_context: `This is a doormat/bathmat product (limpiapies/choapino) — a small mat placed at entrances or bathrooms.`,

      what_to_change: `Change the doormat/bathmat visible in Image 1:
* The MAT -> apply the color and pattern from Image 2

DO NOT change:
* Floor surface around the mat
* Non-textile elements (door, walls, props)`,

      final_check: `Before outputting, verify:
1. Does the MAT match Image 2's color/pattern?
2. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK mat. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      main: `the mat on a pure white background, top-down view.`,
      lifestyle: `the mat placed at a doorway or bathroom entrance. Natural lighting.`,
      default: `a professional product photo of a doormat/bathmat.`,
    },
    qa_focus_areas: [
      'mat color/pattern must match swatch',
    ],
  },

  cortinas: {
    key: 'cortinas',
    label: 'Cortinas',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: true, flatten_hero: false },
    target_surfaces: ['las cortinas / drapeados visibles'],
    preserve_surfaces: [
      'ventana, pared, persianas y marcos',
      'cualquier otro textil de la escena (cama, sofá, cojines, alfombras)',
    ],
    prompt: {
      product_context: `This is a curtain product (cortina) — window curtains or drapes.`,

      what_to_change: `Change ALL curtain textile surfaces visible in Image 1:
* The CURTAINS/DRAPES -> apply the color and pattern from Image 2
* If multiple panels are shown, ALL must match Image 2

Preserve the drape and fall of the curtain — it hangs vertically with natural folds.

DO NOT change:
* Curtain rod/hardware
* Window, walls, furniture
* Lighting from outside the window`,

      final_check: `Before outputting, verify:
1. Do ALL curtain panels match Image 2?
2. Is the drape and translucency preserved?
3. Did I invent any pattern not in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      lifestyle: `curtains hanging at a window in a well-lit room. Natural daylight filtering through. Soft, elegant drape.`,
      main: `curtain panel flat or draped on a pure white background.`,
      default: `a professional product photo of curtains hanging at a window.`,
    },
    qa_focus_areas: [
      'curtain color/pattern must match swatch',
      'drape and translucency preserved',
    ],
  },

  'cubre-colchon': {
    key: 'cubre-colchon',
    label: 'Cubre Colchon Impermeable',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a waterproof mattress protector (cubre colchon impermeable).
It's a fitted cover that goes over the mattress for protection.`,

      what_to_change: `Change the mattress protector surface visible in Image 1:
* The PROTECTOR COVER -> apply the color from Image 2

Mattress protectors are typically white/solid color — preserve the fitted, smooth appearance.

DO NOT change:
* The mattress underneath
* Non-textile elements (bed frame, furniture)`,

      final_check: `Before outputting, verify:
1. Does the PROTECTOR color match Image 2?
2. Is the smooth, fitted appearance preserved?`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. Match the darkness exactly.`,
    },
    shot_compositions: {
      main: `a mattress protector on a mattress, showing its fitted edge. Pure white background.`,
      default: `a professional product photo of a mattress protector.`,
    },
    qa_focus_areas: [
      'protector color must match swatch',
      'fitted appearance preserved',
    ],
  },

  'bolsos-cuero': {
    key: 'bolsos-cuero',
    label: 'Bolsos de Cuero',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a leather bag product (bolso de cuero).
The product has leather surfaces with specific color and texture.`,

      what_to_change: `Change the leather surfaces visible in Image 1:
* The BAG'S LEATHER -> apply the color and texture from Image 2
* All leather panels of the bag must change to match

Preserve the leather's natural characteristics — grain, sheen, stitching.

DO NOT change:
* Metal hardware (zippers, buckles, clasps)
* Lining material (if visible)
* Bag SHAPE and STRUCTURE`,

      final_check: `Before outputting, verify:
1. Does the LEATHER COLOR match Image 2?
2. Is the leather texture/grain preserved?
3. Are hardware elements unchanged?
4. Is the bag shape identical?`,

      dark_swatch_note: `The swatch shows a VERY DARK leather. Match the darkness exactly. Do NOT lighten. Leather grain should still be subtly visible.`,
    },
    shot_compositions: {
      main: `the bag on a pure white background, showing its design and details. Clean studio lighting.`,
      lifestyle: `the bag in a lifestyle context — being held or on a surface. Natural lighting.`,
      default: `a professional product photo of a leather bag.`,
    },
    qa_focus_areas: [
      'leather color must match swatch exactly',
      'leather grain/texture preserved',
      'hardware elements unchanged',
      'bag shape identical to original',
    ],
  },

  'bolsos-materos': {
    key: 'bolsos-materos',
    label: 'Bolsos Materos',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a mate bag (bolso matero) — a specialized bag for carrying a mate set (thermos, mate gourd, etc.).
Made from leather or fabric with compartments for mate accessories.`,

      what_to_change: `Change the bag surfaces visible in Image 1:
* The BAG'S MATERIAL (leather or fabric) -> apply the color and texture from Image 2

DO NOT change:
* Metal hardware (zippers, buckles, clasps)
* Bag SHAPE and STRUCTURE
* Internal compartments (if visible)
* Any mate accessories shown (thermos, gourd)`,

      final_check: `Before outputting, verify:
1. Does the BAG MATERIAL color match Image 2?
2. Is the bag shape identical?
3. Are hardware and accessories unchanged?`,

      dark_swatch_note: `The swatch shows a VERY DARK material. Match the darkness exactly. Do NOT lighten.`,
    },
    shot_compositions: {
      main: `the mate bag on a pure white background, showing its design. Clean studio lighting.`,
      lifestyle: `the mate bag with mate accessories, in a lifestyle setting.`,
      default: `a professional product photo of a mate bag.`,
    },
    qa_focus_areas: [
      'bag material color must match swatch',
      'bag shape and hardware unchanged',
    ],
  },

  _default: {
    key: '_default',
    label: 'Default (Textile)',
    generation_mode: 'edit',
    retry_escalation: 'edit',
    preprocessing: { crop_swatch: false, flatten_hero: false },
    prompt: {
      product_context: `This is a textile product.`,

      what_to_change: `Change ALL fabric/textile surfaces visible in Image 1, matching them to Image 2.

Apply the pattern/color from Image 2 to every textile product visible in Image 1:
* Pillowcases, cushion covers
* Blankets, throws, covers
* Towels, curtains
* Any other fabric product

If Image 2 shows different patterns on different pieces, match each piece accordingly.

DO NOT change:
* Non-textile elements (walls, furniture, floor, props)
* Background surfaces that are NOT part of the product
* Persons, hands, or clothing`,

      final_check: `Before outputting, verify:
1. Does EVERY textile product match the pattern from Image 2?
2. Did I invent any pattern not found in Image 2? If yes -> FIX IT.`,

      dark_swatch_note: `The swatch shows a VERY DARK fabric. The output fabric MUST match the darkness exactly.
Do NOT lighten the fabric. Pattern/texture should be subtle on dark surfaces.`,
    },
    shot_compositions: {
      lifestyle: `a lifestyle scene with the textile product as the main subject. Soft natural lighting.`,
      main: `the product on a pure white background. Clean studio lighting.`,
      default: `a professional product photograph.`,
    },
    qa_focus_areas: [
      'all textile surfaces must match swatch',
      'any visible text MUST be in Spanish — English text = ml_compliance 0.0',
    ],
    learnings: [
      'Todo texto visible en la imagen DEBE estar en español. Este es un producto para MercadoLibre Chile. Nunca generar texto en inglés.',
      'El color base de la tela debe coincidir exactamente con el swatch — no cambiar temperatura de color (blanco→crema, frío→cálido, etc.).',
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Strategy lookup
// ─────────────────────────────────────────────────────────────────────────────

export function getCategoryStrategy(category: string): CategoryStrategy {
  const cat = category.toLowerCase();
  const defaultLearnings = CATEGORY_STRATEGIES._default.learnings || [];

  // Helper: merge default learnings into strategy
  function withDefaultLearnings(strategy: CategoryStrategy): CategoryStrategy {
    const combined = [...(strategy.learnings || []), ...defaultLearnings];
    // Deduplicate
    const unique = [...new Set(combined)];
    return { ...strategy, learnings: unique };
  }

  // Exact match first
  if (CATEGORY_STRATEGIES[cat]) {
    return withDefaultLearnings(CATEGORY_STRATEGIES[cat]);
  }

  // Partial match (e.g., "quilts_roma" matches "quilts")
  for (const [key, strategy] of Object.entries(CATEGORY_STRATEGIES)) {
    if (key !== '_default' && (cat.includes(key) || key.includes(cat))) {
      return withDefaultLearnings(strategy);
    }
  }

  // Fallback
  return CATEGORY_STRATEGIES._default;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shot type composition lookup (for from_scratch generation)
// ─────────────────────────────────────────────────────────────────────────────

function getShotComposition(strategy: CategoryStrategy, shotType: string): string {
  const st = shotType.toLowerCase();

  for (const [key, composition] of Object.entries(strategy.shot_compositions)) {
    if (st.includes(key) || key.includes(st)) {
      return composition;
    }
  }

  return strategy.shot_compositions.default
    || strategy.shot_compositions.lifestyle
    || 'a professional product photograph. Soft, natural lighting.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: format learnings block for injection into prompts
// ─────────────────────────────────────────────────────────────────────────────

function formatLearnings(strategy: CategoryStrategy): string {
  if (!strategy.learnings?.length) return '';
  return `\n\nREGLAS OBLIGATORIAS (aprendidas de errores anteriores):\n${strategy.learnings.map((l) => `• ${l}`).join('\n')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build explicit color temperature anchoring block
// ─────────────────────────────────────────────────────────────────────────────

function formatColorAnchor(swatchHex?: string | null, colorDescription?: string | null): string {
  if (!swatchHex && !colorDescription) return '';

  const lines: string[] = ['\n\nFIDELIDAD DE COLOR (CRÍTICO — NO IGNORAR):'];

  if (colorDescription) {
    lines.push(`El color del swatch es "${colorDescription}".`);
  } else if (swatchHex) {
    lines.push(`El color dominante del swatch es ${swatchHex}.`);
  }

  lines.push(
    'La imagen generada DEBE reproducir EXACTAMENTE la temperatura de color del swatch.',
    'PROHIBIDO calentar blancos: si el swatch es blanco/frío, el resultado NO puede ser crema/beige/cálido.',
    'PROHIBIDO enfriar cálidos: si el swatch es cálido, el resultado NO puede ser gris/frío.',
    'Copia el color TAL CUAL aparece en la imagen del swatch — sin interpretar ni embellecer.'
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder: EDIT mode (hero + swatch — surgical swap)
// ─────────────────────────────────────────────────────────────────────────────

export function buildEditPrompt(
  strategy: CategoryStrategy,
  swatchName: string,
  colorDescription: string | null,
  shotType: string,
  isDarkSwatch: boolean = false,
  qaFeedback?: string | null,
  resolution: string = '1200x1200',
  _swatchHex?: string | null,
  patternsDiffer: boolean = false,
  heroTextElements?: Array<{ text: string; position?: string; size?: string; role?: string }> | null,
): string {
  const darkNote = isDarkSwatch ? ' No aclares la tela — debe ser igual de oscura que la Imagen 2.' : '';
  // When the hero is classified as `detail` but actually carries text overlays
  // (BANVA branding, dimensions, headlines, OEKO-TEX badges), the default
  // "close-up de tela" template makes Gemini regenerate the scene from scratch
  // and lose every overlay. Detect overlays here and inject a preserve clause.
  // See post-mortem of job 8731dbfa-80a0-4b91-b869-64bc5485196a (limpiapies/Cat).
  const hasHeroOverlays = (heroTextElements?.length ?? 0) > 0;
  const overlayList = hasHeroOverlays
    ? heroTextElements!.map(el => `- "${el.text}"${el.position ? ` (${el.position})` : ''}`).join('\n')
    : '';
  const overlayPreserveNote = hasHeroOverlays ? `

PRESERVAR OVERLAYS DEL HERO — REGLA CRÍTICA:
La Imagen 1 contiene overlays de texto, branding, cotas e infografía superpuestos sobre el producto. ESOS OVERLAYS DEBEN APARECER IDÉNTICOS EN EL RESULTADO — mismo contenido, misma posición, mismo tamaño, misma fuente, mismo color. NO los borres. NO los muevas. NO los traduzcas. Solo cambia la TELA del producto que está debajo de ellos.
Lista de elementos a preservar:
${overlayList}` : '';
  // When patterns differ, DISCARD any verifier qaFeedback — it usually says
  // "pattern doesn't match" which Gemini reads as "preserve the hero's pattern
  // (the model the verifier expected)", directly contradicting the REEMPLAZO
  // COMPLETO rule below. The REEMPLAZO rule is the authoritative instruction
  // for this case; the verifier's free-text complaint is noise.
  const effectiveQaFeedback = patternsDiffer ? null : qaFeedback;
  const qaNote = effectiveQaFeedback ? `\nINTENTO ANTERIOR FALLÓ: "${effectiveQaFeedback}"` : '';
  // Force-replace section: only injected when arePatternsSimilar returned false.
  // Without this, Gemini 3 Pro Image preserves distinctive painted patterns
  // from the hero (leaves, florals, motifs) and only changes color superficially.
  // Verified manually: a strong "REPLACE COMPLETELY, the hero pattern must
  // disappear" instruction makes Gemini actually swap the pattern.
  const replaceNote = patternsDiffer ? `

REEMPLAZO COMPLETO DEL PATRÓN — REGLA CRÍTICA:
La tela del producto en Imagen 1 tiene un patrón distintivo (hojas, flores, motivos, dibujos pintados). Esos motivos son un PATRÓN PINTADO sobre tela plana — NO son geometría 3D, NO son estructura del producto. DEBEN DESAPARECER COMPLETAMENTE del resultado.

NO los preserves como si fueran estructura. NO cambies solo el color manteniendo las formas. NO mezcles con el patrón de Imagen 2. Pensá en esto como "borrar la tela del hero" y "pintar encima con la tela de Imagen 2".

La tela del resultado debe verse PIXEL A PIXEL como la tela de Imagen 2 — mismo color, mismo patrón, misma escala de motivos, misma textura. El cuerpo del cubrecama Y las fundas deben tener AMBOS el mismo patrón uniforme de Imagen 2 (no uno con el patrón de Imagen 2 y otro con vestigios del hero). Si el resultado mantiene cualquier elemento del patrón original de Imagen 1 (hojas, flores, motivos, formas del hero), falló.

Solo la composición (muebles, personas, animales, almohadas, fondo, iluminación) viene del hero — la TELA viene 100% de Imagen 2.` : '';

  if (shotType === 'detail') {
    // If the strategy has a category-specific detail rule, use it (overrides generic).
    // This is crucial for quilts where we must NOT invent texture and must NOT
    // preserve hero relief.
    const detailRule = strategy.prompt.what_to_change_detail;
    const opener = hasHeroOverlays
      ? 'Toma la Imagen 1 y reemplaza ÚNICAMENTE la tela del producto con la tela de la Imagen 2. Mantén intacto el resto de la Imagen 1 (layout, fondo, overlays, branding, cotas, badges, gráficos).'
      : 'Genera la Imagen 1 (close-up de tela) con el color y textura de la Imagen 2. Misma composición, ángulo y pliegues.';
    if (detailRule) {
      return `${opener}

${detailRule}${darkNote}${qaNote}${replaceNote}${overlayPreserveNote}

Si hay texto en inglés, traducir al español. Sin marcas de agua. Imagen fotorrealista de ${resolution}.`;
    }
    return `${opener}${darkNote}${qaNote}${replaceNote}${overlayPreserveNote}

Imagen fotorrealista de ${resolution}.`;
  }

  if (shotType === 'infografia') {
    return `Toma Imagen 1 (infografía de comparación de producto vs competidor) y reemplaza la tela del LADO IZQUIERDO (el lado del producto propio) con la tela de Imagen 2. El fabric del lado izquierdo debe tomar el color, patrón y textura completos de Imagen 2.

FRAMING — REGLA CRÍTICA:
El LADO IZQUIERDO de Imagen 1 es un CLOSEUP PLANO de superficie textil (textura de tela ocupando toda la zona, sin cama ni habitación). El resultado DEBE mantener ese mismo closeup plano — solo cambia el patrón/color/textura de la tela, nada más.
  - NO renders de cama, cabecera, almohadas, sábanas dobladas, ropa de cama armada.
  - NO renders de habitación, muebles, mesa de noche, ventanas, plantas, decoración.
  - NO incorpores NINGÚN elemento compositivo de Imagen 2 — Imagen 2 es SOLO referencia de la tela (color, patrón, textura). La composición/framing de Imagen 2 no se usa.
  - Si Imagen 2 muestra una cama con la tela puesta, IGNORA la cama y extrae SOLO la superficie textil.
  - El resultado debe verse como si la tela nueva estuviera aplicada pixel a pixel sobre el closeup plano del lado izquierdo original.

El lado derecho (competidor/Others), los checkmarks, los iconos, la gota/ilustración, el layout, el framing, el tamaño y la posición de TODOS los elementos quedan EXACTAMENTE IGUAL a Imagen 1.

TEXTO — TRADUCIR AL ESPAÑOL:
Si la Imagen 1 contiene texto en inglés, TRADÚCELO al español. El texto DEBE estar en español en el resultado final. Ejemplos comunes:
  - "Bedsure" / cualquier marca de competidor en el lado izquierdo → "Banva Home"
  - "Ultrasonic Binding" → "Unión Ultrasónica"
  - "No stitches" → "Sin costuras"
  - "Prevent seam slippage" → "Previene deslizamiento de costuras"
  - "Keep filling in place" → "Mantiene el relleno en su lugar"
  - "Unraveling" → "Deshilachado"
  - "Stiffer" → "Más rígido"
  - "Pet-unfriendly" / "Not pet friendly" → "No apto para mascotas"
  - "Others" puede quedar igual o traducirse a "Otros"
Mantén la MISMA POSICIÓN y tamaño de cada texto — solo cambia el idioma del contenido.${darkNote}${qaNote}

Imagen fotorrealista de ${resolution}.`;
  }

  // Use shot-type-aware instructions if category has them
  const whatToChange = strategy.prompt.what_to_change;

  return `Toma Imagen 1 y cámbiale SOLO la tela del producto al color/patrón/textura de Imagen 2. ${whatToChange}${darkNote}${qaNote}${replaceNote}

Imagen 1 es la composición exacta: mantén personas, rostros, expresiones, manos, pelo, fondo, muebles, lámpara, objetos de mesa de noche, almohadas decorativas, iluminación, encuadre y foco idénticos. MISMA cantidad de almohadas, misma posición, mismo tamaño. Solo la tela del producto cambia. Si hay texto en inglés, traducir al español. Sin marcas de agua.

Imagen fotorrealista de ${resolution}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder: REFERENCE mode (hero as visual guide + swatch)
// ─────────────────────────────────────────────────────────────────────────────

export function buildReferencePrompt(
  strategy: CategoryStrategy,
  swatchName: string,
  colorDescription: string | null,
  shotType: string,
  isDarkSwatch: boolean = false,
  qaFeedback?: string | null,
  resolution: string = '1200x1200',
  swatchHex?: string | null
): string {
  const darkNote = isDarkSwatch ? ' La tela debe ser igual de oscura que la Imagen 2.' : '';
  const qaNote = qaFeedback ? `\nINTENTO ANTERIOR FALLÓ: "${qaFeedback}"` : '';

  if (shotType === 'detail') {
    return `Genera un close-up de textura IDÉNTICO a la Imagen 1 (misma composición, ángulo, pliegues) pero con el color y textura de la Imagen 2.${darkNote}${qaNote}

Imagen fotorrealista de ${resolution}.`;
  }

  if (shotType === 'infografia') {
    return `Genera la Imagen 1 con la tela de la Imagen 2. Mantén íconos, logos y layout exactamente igual. Solo cambia el color/patrón del textil. Si hay texto en inglés, TRADÚCELO al español (ej: "No stitching" → "Sin costuras").${darkNote}${qaNote}

Imagen fotorrealista de ${resolution}.`;
  }

  // Standard reference mode: composition from Image 1, fabric from Image 2.
  // When the category declares target_surfaces / preserve_surfaces, render an
  // explicit scope so Gemini doesn't bleed the design to other textiles in the
  // scene (e.g. applying a rug pattern to the sofa and bed in a lifestyle shot).
  const hasSurfaces = (strategy.target_surfaces?.length ?? 0) > 0
    || (strategy.preserve_surfaces?.length ?? 0) > 0;

  if (hasSurfaces) {
    const targetList = (strategy.target_surfaces ?? [`el/la ${strategy.label.toLowerCase()}`])
      .map((s) => `- ${s}`)
      .join('\n');
    const preserveList = (strategy.preserve_surfaces ?? [])
      .map((s) => `- ${s}`)
      .join('\n');
    const preserveBlock = preserveList
      ? `\n\nPRESERVAR SIN CAMBIOS (NO repintar, NO recolorear, NO aplicar el patrón de Imagen 2):\n${preserveList}\n- Cualquier otro textil de la escena no listado arriba como target`
      : '';

    return `Imagen 1 = composición (ángulo, escena, disposición). Imagen 2 = diseño del producto (color, patrón, textura).

APLICAR el diseño EXACTO de Imagen 2 SOLO en:
${targetList}${preserveBlock}

El patrón de Imagen 2 NO debe "sangrar" a otras superficies. Copia el color EXACTO de Imagen 2 únicamente en las superficies target listadas.${darkNote}${qaNote}

Si hay texto en inglés, traducir al español. Sin marcas de agua. Imagen fotorrealista de ${resolution}.`;
  }

  // Legacy fallback for categories that haven't declared surfaces yet.
  return `Imagen 1 = composición (ángulo, escena, disposición). Imagen 2 = tela (color, patrón, textura).

Genera la misma escena de la Imagen 1 pero con la tela de la Imagen 2 en el ${strategy.label} y fundas. NO conserves la textura original de la Imagen 1. Copia el color EXACTO de la Imagen 2.${darkNote}${qaNote}

Si hay texto en inglés, traducir al español. Sin marcas de agua. Imagen fotorrealista de ${resolution}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder: FROM_SCRATCH mode (swatch only, text description)
// ─────────────────────────────────────────────────────────────────────────────

export function buildFromScratchPrompt(
  strategy: CategoryStrategy,
  swatchName: string,
  _colorDescription: string | null,
  shotType: string,
  isDarkSwatch: boolean = false,
  qaFeedback?: string | null,
  resolution: string = '1200x1200',
  _swatchHex?: string | null
): string {
  const composition = getShotComposition(strategy, shotType);
  const darkNote = isDarkSwatch ? ' Tela oscura — no aclares.' : '';
  const qaNote = qaFeedback ? `\nINTENTO ANTERIOR FALLÓ: "${qaFeedback}"` : '';

  return `La imagen es una muestra de tela. Genera una foto e-commerce de ${strategy.label}: ${composition}

El producto debe tener el mismo color, patrón y textura que la muestra.${darkNote}${qaNote}

Texto en español. Sin marcas de agua. Imagen fotorrealista de ${resolution}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified prompt builder — dispatches to the correct mode
// ─────────────────────────────────────────────────────────────────────────────

export function buildPromptForMode(
  mode: GenerationMode,
  strategy: CategoryStrategy,
  swatchName: string,
  colorDescription: string | null,
  shotType: string,
  isDarkSwatch: boolean = false,
  qaFeedback?: string | null,
  resolution: string = '1200x1200',
  swatchHex?: string | null,
  patternsDiffer: boolean = false,
  heroTextElements?: Array<{ text: string; position?: string; size?: string; role?: string }> | null,
): string {
  switch (mode) {
    case 'edit':
      return buildEditPrompt(strategy, swatchName, colorDescription, shotType, isDarkSwatch, qaFeedback, resolution, swatchHex, patternsDiffer, heroTextElements);
    case 'reference':
      return buildReferencePrompt(strategy, swatchName, colorDescription, shotType, isDarkSwatch, qaFeedback, resolution, swatchHex);
    case 'from_scratch':
      return buildFromScratchPrompt(strategy, swatchName, colorDescription, shotType, isDarkSwatch, qaFeedback, resolution, swatchHex);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine effective generation mode based on attempt and strategy
// ─────────────────────────────────────────────────────────────────────────────

export function getEffectiveMode(strategy: CategoryStrategy, attempt: number): GenerationMode {
  if (attempt === 0) {
    return strategy.generation_mode;
  }
  // On retry, escalate if configured, otherwise use same mode
  return strategy.retry_escalation || strategy.generation_mode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine effective temperature based on mode and attempt
// ─────────────────────────────────────────────────────────────────────────────

export function getEffectiveTemperature(
  strategy: CategoryStrategy,
  mode: GenerationMode,
  attempt: number
): number {
  const base = strategy.temperature ?? 0.2;

  if (mode === 'from_scratch') {
    // From scratch needs slightly more creativity
    return Math.max(base, 0.4);
  }

  if (mode === 'reference') {
    // Reference mode: slightly more creative than edit
    return Math.max(base, 0.3);
  }

  // Edit mode: force low temperature regardless of strategy base.
  // Strategy bases (e.g. quilts 0.4) are tuned for from_scratch/reference.
  // Edit mode must be deterministic to preserve non-fabric pixels
  // (faces, hands, bodies, poses) from the hero exactly.
  if (attempt > 0) return 0.2;
  return 0.1;
}

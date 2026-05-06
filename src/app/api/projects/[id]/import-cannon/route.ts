import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { mlGet } from '@/lib/ml';
import { ensureOutputSpec } from '@/lib/image-processing';

export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function getInventorySupabase() {
  const url = process.env.INVENTORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.INVENTORY_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Keeps dots (for filename size like "1.5plazas" — Cannon preserves the dot)
function slugifyKeepDot(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '');
}

// For page URL: "1.5 plazas" → "1-5-plazas" (Cannon replaces dot with dash in URL key)
function slugifyForPageUrl(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// "Sabanas Polar 1.5 Plazas Drago" → "Drago"
// "Sabanas 144 Hilos 2 Plazas Oasis Verde" → "Oasis Verde"
function extractDesignFromTitle(title: string): string | null {
  const match = title.match(/plazas?\s+(.+?)(?:\s*[-|(].*)?$/i);
  return match ? match[1].trim() : null;
}

// Smarter design extraction: pick the first non-stopword non-numeric token
// whose normalised form is unique in the title. Works for titles where
// "plazas" is in the middle (e.g. "Sabanas King Cannon 200 Hilos 2 Plaza
// Media Full 100 Algodon Express 200 Hilos" → "Express").
const TITLE_STOPWORDS = new Set([
  'cm', 'm',
  'plazas', 'plaza', 'king', 'super',
  'de', 'y', 'en', 'la', 'el', 'con', 'para', 'del', 'a',
  'sabanas', 'sabana', 'sábanas', 'sábana',
  'cannon', 'cannonhome',
  'hilos', 'hilo',
  'algodon', 'algodón', 'poliester', 'poliéster',
  'media', 'full', 'twin', 'queen',
  'set', 'juego', 'pack',
  'mercadolibre', 'envio', 'envío',
  'polar', 'fleece',
]);
function normalizeWord(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function extractDesignFromTitleSmart(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of words) {
    const n = normalizeWord(w);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  for (const w of words) {
    const n = normalizeWord(w);
    if (TITLE_STOPWORDS.has(n)) continue;
    if (/^\d+([.,]\d+)?$/.test(w)) continue;
    if (w.length <= 1) continue;
    if (counts.get(n) === 1) return w;
  }
  return null;
}

// Extract size from title: "King" / "Super King" / "1.5 plazas" / "2 plazas"
function extractSizeFromTitle(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const n = normalizeWord(words[i]);
    if (n === 'king' || n === 'super') {
      const nx = words[i + 1];
      if (nx && normalizeWord(nx) === 'super') return `${words[i]} ${nx}`;
      if (n === 'super' && nx && normalizeWord(nx) === 'king') return `${words[i]} ${nx}`;
      return words[i];
    }
    if (n === 'plaza' || n === 'plazas') {
      const pv = words[i - 1];
      if (pv && /^\d+([.,]\d+)?$/.test(pv)) return `${pv} ${words[i]}`;
      return words[i];
    }
  }
  return null;
}

// Extract thread count from title: "200 Hilos" → "200"
function extractThreadCountFromTitle(title: string): string | null {
  const m = title.match(/(\d+)\s*hilos?/i);
  return m ? m[1] : null;
}

function buildCannonImagePatterns(
  attrs: Record<string, string>,
  title?: string
): string[] {
  const fabricDesign = attrs.FABRIC_DESIGN;
  const model = attrs.MODEL || '';
  // Prefer attrs.MATTRESS_SIZE; fall back to size parsed from the title; only
  // use "2 plazas" as last resort. This is what makes "King" listings work.
  const size =
    attrs.MATTRESS_SIZE ||
    (title ? extractSizeFromTitle(title) : null) ||
    '2 plazas';
  const color = attrs.COLOR || attrs.MAIN_COLOR || '';
  const fabric = attrs.FABRIC_COMPOSITION || attrs.FABRIC || '';

  const titleDesign = title ? extractDesignFromTitle(title) : null;
  const titleDesignSmart = title ? extractDesignFromTitleSmart(title) : null;

  // Design candidates: title-based first (more specific than generic "Estampado")
  const designCandidates: string[] = [];
  const addDesign = (d: string | null | undefined) => {
    if (!d) return;
    const compact = slugify(d.replace(/\s*\d+$/, ''));
    if (compact && !designCandidates.includes(compact)) designCandidates.push(compact);
  };
  addDesign(titleDesignSmart);
  addDesign(titleDesign);
  addDesign(fabricDesign);

  if (!designCandidates.length) return [];

  // Size candidates: dot preserved first ("1.5plazas"), then stripped ("15plazas")
  const sizeCandidates = [slugifyKeepDot(size)];
  const sizeNoDot = slugify(size);
  if (sizeNoDot && sizeNoDot !== sizeCandidates[0]) sizeCandidates.push(sizeNoDot);

  const colorCompact = slugify(color);
  const threadMatch =
    model.match(/(\d+)\s*hilos/i) ||
    (title ? title.match(/(\d+)\s*hilos/i) : null);
  const threadCount = threadMatch ? threadMatch[1] : (title ? extractThreadCountFromTitle(title) : null);
  const isPolar = /polar|fleece/i.test(
    `${model} ${fabric} ${fabricDesign || ''} ${title || ''}`
  );

  const patterns: string[] = [];
  for (const designCompact of designCandidates) {
    for (const sizeCompact of sizeCandidates) {
      if (isPolar) {
        if (colorCompact) {
          patterns.push(`sabanaspolar${sizeCompact}${designCompact}${colorCompact}`);
          patterns.push(`sabanaspolar${sizeCompact}${colorCompact}`);
        }
        patterns.push(`sabanaspolar${sizeCompact}${designCompact}`);
      }
      if (threadCount) {
        patterns.push(`sabanas${sizeCompact}${threadCount}hilos${designCompact}`);
      }
      if (!threadCount && !isPolar) {
        patterns.push(`sabanas${sizeCompact}144hilos${designCompact}`);
      }
    }
  }
  return [...new Set(patterns)];
}

function buildCannonPageUrls(
  attrs: Record<string, string>,
  title?: string
): string[] {
  const fabricDesign = attrs.FABRIC_DESIGN;
  const model = attrs.MODEL || '';
  const size =
    attrs.MATTRESS_SIZE ||
    (title ? extractSizeFromTitle(title) : null) ||
    '2 plazas';
  const fabric = attrs.FABRIC_COMPOSITION || attrs.FABRIC || '';

  const titleDesign = title ? extractDesignFromTitle(title) : null;
  const titleDesignSmart = title ? extractDesignFromTitleSmart(title) : null;

  const designCandidates: string[] = [];
  const addDesign = (d: string | null | undefined) => {
    if (!d) return;
    const slug = slugifyForPageUrl(d.replace(/\s*\d+$/, ''));
    if (slug && !designCandidates.includes(slug)) designCandidates.push(slug);
  };
  addDesign(titleDesignSmart);
  addDesign(titleDesign);
  addDesign(fabricDesign);

  if (!designCandidates.length) return [];

  const sizeSlug = slugifyForPageUrl(size);
  const threadMatch =
    model.match(/(\d+)\s*hilos/i) ||
    (title ? title.match(/(\d+)\s*hilos/i) : null);
  const threadCount = threadMatch ? threadMatch[1] : (title ? extractThreadCountFromTitle(title) : null);
  const isPolar = /polar|fleece/i.test(
    `${model} ${fabric} ${fabricDesign || ''} ${title || ''}`
  );

  const urls: string[] = [];
  for (const design of designCandidates) {
    if (isPolar) {
      urls.push(`https://cannonhome.cl/sabanas-polar-${sizeSlug}-${design}.html`);
    }
    if (threadCount) {
      urls.push(`https://cannonhome.cl/sabanas-${sizeSlug}-${threadCount}-hilos-${design}.html`);
    }
    if (!threadCount && !isPolar) {
      urls.push(`https://cannonhome.cl/sabanas-${sizeSlug}-144-hilos-${design}.html`);
    }
  }
  return [...new Set(urls)];
}

// Fetch product page and extract all sabanas*_N.jpg filenames referenced in the HTML.
// Magento stores originals at /media/catalog/product/s/a/{filename} for filenames starting with "sa".
async function scrapeCannonProductImages(pageUrl: string): Promise<string[]> {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.matchAll(
      /\b(sabanas[a-z0-9.]+?_\d+(?:_\d+)?)\.(jpg|jpeg|png|webp)\b/gi
    );
    const filenames = new Set<string>();
    for (const m of matches) {
      filenames.add(`${m[1]}.${m[2].toLowerCase()}`);
    }
    return [...filenames].map(
      (fn) => `https://cannonhome.cl/media/catalog/product/s/a/${fn}`
    );
  } catch {
    return [];
  }
}

function cannonUrl(pattern: string, index: number, variant?: number): string {
  const suffix = variant ? `_${index}_${variant}` : `_${index}`;
  return `https://cannonhome.cl/media/catalog/product/s/a/${pattern}${suffix}.jpg`;
}

/**
 * POST /api/projects/{id}/import-cannon
 * Body: { swatch_ids?: string[] } — optional filter, defaults to all swatches
 *
 * For each swatch:
 * 1. Gets ML item attributes (BRAND, FABRIC_DESIGN, etc.)
 * 2. Builds Cannon image URLs
 * 3. Downloads all available images
 * 4. Creates approved generation_jobs for each image
 *
 * Result: images appear in project results, ready to publish to ML.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: projectId } = await context.params;
  const supabase = createAdminClient();
  const inventoryDb = getInventorySupabase();
  const body = await request.json().catch(() => ({}));
  const filterSwatchIds: string[] | undefined = body.swatch_ids;
  const force: boolean = body.force === true;

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('id, category')
    .eq('id', projectId)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get swatches
  let swatchQuery = supabase
    .from('swatches')
    .select('id, name, sku_suffix, storage_path')
    .eq('project_id', projectId)
    .order('display_order');

  const { data: swatches } = await swatchQuery;
  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches found' }, { status: 400 });
  }

  const targetSwatches = filterSwatchIds?.length
    ? swatches.filter((s) => filterSwatchIds.includes(s.id))
    : swatches;

  // Get or create a batch for imports
  let batchId: string;
  const { data: existingBatch } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingBatch?.length) {
    batchId = existingBatch[0].id;
  } else {
    const { data: newBatch } = await supabase
      .from('generation_batches')
      .insert({
        project_id: projectId,
        status: 'completed',
        total_combinations: 0,
        completed_count: 0,
        approved_count: 0,
        retry_count: 0,
        flagged_count: 0,
        error_count: 0,
      })
      .select()
      .single();
    batchId = newBatch!.id;
  }

  // We need a hero_shot to associate jobs with — create a placeholder if none exists
  let heroShotId: string;
  const { data: existingHero } = await supabase
    .from('hero_shots')
    .select('id')
    .eq('project_id', projectId)
    .limit(1);

  if (existingHero?.length) {
    heroShotId = existingHero[0].id;
  } else {
    const { data: newHero } = await supabase
      .from('hero_shots')
      .insert({
        project_id: projectId,
        filename: 'cannon-import',
        shot_type: 'main',
        storage_path: '',
        display_order: 0,
      })
      .select()
      .single();
    heroShotId = newHero!.id;
  }

  const results: {
    swatch: string;
    sku: string;
    images_imported: number;
    errors: string[];
    debug?: { attrs?: Record<string, string>; patterns?: string[]; working?: string | null };
  }[] = [];

  // Get all existing cannon imports for this project to avoid duplicates
  const batchIds = [batchId];
  const { data: allBatches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', projectId);
  if (allBatches) {
    for (const b of allBatches) {
      if (!batchIds.includes(b.id)) batchIds.push(b.id);
    }
  }

  const { data: existingJobs } = await supabase
    .from('generation_jobs')
    .select('swatch_id, prompt_metadata')
    .in('batch_id', batchIds)
    .eq('status', 'approved');

  const swatchesWithCannonImport = new Set<string>();
  for (const job of existingJobs || []) {
    const meta = job.prompt_metadata as Record<string, unknown> | null;
    if (meta?.strategy === 'cannon_import') {
      swatchesWithCannonImport.add(job.swatch_id);
    }
  }

  for (const swatch of targetSwatches) {
    if (!swatch.sku_suffix) {
      results.push({ swatch: swatch.name, sku: '', images_imported: 0, errors: ['No SKU'] });
      continue;
    }

    // Skip if already imported from Cannon (unless force=true)
    if (!force && swatchesWithCannonImport.has(swatch.id)) {
      results.push({ swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: ['Ya importado de Cannon'] });
      continue;
    }

    // Force mode: delete previous Cannon imports for this swatch
    if (force && swatchesWithCannonImport.has(swatch.id)) {
      const { data: oldJobs } = await supabase
        .from('generation_jobs')
        .select('id, output_storage_path, prompt_metadata')
        .in('batch_id', batchIds)
        .eq('swatch_id', swatch.id)
        .eq('status', 'approved');
      for (const oldJob of oldJobs || []) {
        const meta = oldJob.prompt_metadata as Record<string, unknown> | null;
        if (meta?.strategy === 'cannon_import') {
          if (oldJob.output_storage_path) {
            await supabase.storage.from('images').remove([oldJob.output_storage_path]);
          }
          await supabase.from('generation_jobs').delete().eq('id', oldJob.id);
        }
      }
    }

    const swatchResult: typeof results[number] = { swatch: swatch.name, sku: swatch.sku_suffix, images_imported: 0, errors: [] as string[], debug: {} };

    try {
      // Find item_id
      const { data: mlItem } = await inventoryDb
        .from('ml_items_map')
        .select('item_id')
        .eq('sku_venta', swatch.sku_suffix)
        .eq('activo', true)
        .is('variation_id', null)
        .maybeSingle();

      let itemId = mlItem?.item_id;
      if (!itemId) {
        const search = await mlGet<{ results: string[] }>(
          `/users/1953806321/items/search?seller_sku=${swatch.sku_suffix}&limit=1`
        );
        if (search?.results?.[0]) itemId = search.results[0];
      }

      if (!itemId) {
        swatchResult.errors.push('SKU not found in ML');
        results.push(swatchResult);
        continue;
      }

      // Get attributes + title (title is needed when FABRIC_DESIGN is generic like "Estampado")
      const item = await mlGet<{
        title: string;
        attributes: Array<{ id: string; value_name: string | null }>;
      }>(`/items/${itemId}?attributes=title,attributes`);

      if (!item?.attributes) {
        swatchResult.errors.push('Could not fetch attributes');
        results.push(swatchResult);
        continue;
      }

      const attrs: Record<string, string> = {};
      for (const attr of item.attributes) {
        if (attr.value_name) attrs[attr.id] = attr.value_name;
      }
      swatchResult.debug!.attrs = attrs;

      const brand = (attrs.BRAND || '').toLowerCase();
      if (!brand.includes('cannon') && !brand.includes('american family')) {
        swatchResult.errors.push(`Not Cannon (brand: ${attrs.BRAND || 'unknown'})`);
        results.push(swatchResult);
        continue;
      }

      // Build Cannon URL patterns (uses title as fallback for design when FABRIC_DESIGN is generic)
      const patterns = buildCannonImagePatterns(attrs, item.title);
      swatchResult.debug!.patterns = patterns;

      // Helper: fetch URL and return buffer if it's a real image (>5KB), null otherwise
      const tryFetch = async (url: string): Promise<Buffer | null> => {
        try {
          const res = await fetch(url, { headers: { 'Accept': 'image/*' } });
          if (!res.ok) return null;
          const ct = res.headers.get('content-type') || '';
          if (!ct.startsWith('image/')) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 5000) return null;
          return buf;
        } catch {
          return null;
        }
      };

      let workingPattern: string | null = null;
      let workingVariant: number | undefined;
      // Find first pattern where _1_1 OR _1 returns a real image
      for (const p of patterns) {
        // Try product-specific variant first: _1_1.jpg
        const specific = await tryFetch(cannonUrl(p, 1, 1));
        if (specific) {
          workingPattern = p;
          workingVariant = 1;
          break;
        }
        // Then try generic: _1.jpg
        const generic = await tryFetch(cannonUrl(p, 1));
        if (generic) {
          workingPattern = p;
          workingVariant = undefined;
          break;
        }
      }

      swatchResult.debug!.working = workingPattern;

      // Build list of image URLs to download. Prefer pattern-based discovery,
      // fall back to scraping the Cannon product page if patterns don't match.
      let imageUrls: string[] = [];
      let scrapedMode = false;

      if (workingPattern) {
        for (let idx = 1; idx <= 10; idx++) {
          imageUrls.push(cannonUrl(workingPattern, idx, workingVariant));
        }
      } else {
        const pageUrls = buildCannonPageUrls(attrs, item.title);
        (swatchResult.debug as Record<string, unknown>).page_urls = pageUrls;
        for (const pageUrl of pageUrls) {
          const scraped = await scrapeCannonProductImages(pageUrl);
          if (scraped.length > 0) {
            imageUrls = scraped;
            scrapedMode = true;
            (swatchResult.debug as Record<string, unknown>).scraped_from = pageUrl;
            break;
          }
        }
      }

      if (imageUrls.length === 0) {
        swatchResult.errors.push(
          `No images found at Cannon (patterns: ${patterns.join(', ')})`
        );
        results.push(swatchResult);
        continue;
      }

      // Download images. Pattern mode: stop at first gap. Scrape mode: skip gaps.
      for (const url of imageUrls) {
        try {
          const res = await fetch(url, { headers: { 'Accept': 'image/*' } });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok || !contentType.startsWith('image/')) {
            if (scrapedMode) continue;
            break;
          }

          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 5000) {
            if (scrapedMode) continue;
            break;
          }

          // Post-process to 1200x1200
          const processed = await ensureOutputSpec(buffer, 1200);

          // Upload
          const jobId = crypto.randomUUID();
          const storagePath = `projects/${projectId}/generated/${jobId}.png`;
          await supabase.storage.from('images').upload(storagePath, processed, {
            contentType: 'image/png',
            upsert: true,
          });

          // Create approved job
          await supabase.from('generation_jobs').insert({
            id: jobId,
            batch_id: batchId,
            hero_shot_id: heroShotId,
            swatch_id: swatch.id,
            status: 'approved',
            attempt: 0,
            output_storage_path: storagePath,
            qa_score: 1.0,
            prompt_metadata: {
              strategy: 'cannon_import',
              source_url: url,
              design: attrs.FABRIC_DESIGN,
            },
          });

          swatchResult.images_imported++;
        } catch {
          if (scrapedMode) continue;
          break;
        }
      }
    } catch (err) {
      swatchResult.errors.push(err instanceof Error ? err.message : String(err));
    }

    results.push(swatchResult);
  }

  // Update batch counts
  const totalImported = results.reduce((sum, r) => sum + r.images_imported, 0);
  await supabase
    .from('generation_batches')
    .update({
      approved_count: totalImported,
      completed_count: totalImported,
      total_combinations: totalImported,
    })
    .eq('id', batchId);

  return NextResponse.json({
    total_swatches: results.length,
    total_images: totalImported,
    success: results.filter((r) => r.images_imported > 0).length,
    skipped: results.filter((r) => r.images_imported === 0 && r.errors.length === 0).length,
    errors: results.filter((r) => r.errors.length > 0).length,
    details: results,
  });
}

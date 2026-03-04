import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark } from '@/lib/image-processing';
import { COST_PER_IMAGE_USD, DELAY_BETWEEN_REQUESTS_SEC } from '@/lib/constants';

// Vercel serverless: max execution time (free=60s, pro=300s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export function getCategoryRule(category: string): { rule2: string; finalCheck: string } {
  const cat = category.toLowerCase();

  if (cat.includes('quilt')) {
    return {
      rule2: `═══════════════════════════════════════════
RULE #2 — WHAT TO CHANGE (QUILT category)
═══════════════════════════════════════════
PRODUCT CONTEXT: A quilt is a lightweight bed COVER (cobertor), NOT a sheet.
The quilt product set includes: the quilt itself (bed cover) + matching pillowcases.
There are NO sheets and NO fitted sheets in this product.

What to change in Image 1:
• The QUILT / BED COVER (the large textile covering the bed) → apply the quilt pattern/color from Image 2
• The PILLOWCASES → apply the pillowcase pattern/color from Image 2 (same tones as the quilt)

The quilt and pillowcases in Image 2 share the same color tones. Apply them accordingly.

DO NOT change:
• The bed surface UNDERNEATH the quilt (mattress, fitted sheet, bed base) — keep as-is
• Non-textile elements (walls, furniture, floor, props, headboard)
• Persons, hands, or clothing`,

      finalCheck: `═══════════════════════════════════════════
FINAL CHECK
═══════════════════════════════════════════
Before outputting, verify:
1. Is the camera angle IDENTICAL to Image 1?
2. Are the products in the SAME position as Image 1?
3. Did I add any elements that weren't in Image 1? If yes → REMOVE IT.
4. Does the QUILT/BED COVER match the quilt pattern from Image 2?
5. Do the PILLOWCASES match the pillowcase tones from Image 2?
6. Did I accidentally change the surface UNDERNEATH the quilt? It should be unchanged.
7. Did I invent any pattern not found in Image 2? If yes → FIX IT.`
    };
  }

  if (cat.includes('sabana') || cat.includes('sábana')) {
    return {
      rule2: `═══════════════════════════════════════════
RULE #2 — WHAT TO CHANGE (SABANAS category)
═══════════════════════════════════════════
PRODUCT CONTEXT: This is a bed sheet set (juego de sábanas).
The set includes: pillowcases + flat/top sheet + fitted sheet (sábana bajera).

IMPORTANT — Image 2 may show DIFFERENT patterns for different pieces:
• The PILLOWCASES in Image 2 have one pattern (could be floral, striped, etc.)
• The FITTED SHEET (sábana bajera) in Image 2 may have a DIFFERENT pattern (often stripes or solid color)

Apply each pattern to the correct piece in Image 1:
• Pillowcases in Image 1 → use the PILLOWCASE pattern from Image 2
• The flat surface underneath the pillows (fitted sheet) → use the FITTED SHEET pattern from Image 2
• If a top sheet is visible in Image 1 → use its corresponding pattern from Image 2

If Image 2 shows only ONE pattern for everything → apply that same pattern to all textiles.
If you cannot clearly distinguish the fitted sheet pattern in Image 2 → use the dominant background color/pattern visible beneath the pillows in Image 2.

DO NOT change:
• Non-textile elements (walls, furniture, floor, props)
• Persons, hands, or clothing`,

      finalCheck: `═══════════════════════════════════════════
FINAL CHECK
═══════════════════════════════════════════
Before outputting, verify:
1. Is the camera angle IDENTICAL to Image 1?
2. Are the products in the SAME position as Image 1?
3. Did I add any elements that weren't in Image 1? If yes → REMOVE IT.
4. Do the PILLOWCASES match the pillowcase pattern from Image 2?
5. Does the FITTED SHEET match the fitted sheet pattern from Image 2? (NOT gray unless the swatch shows gray)
6. Did I invent any pattern not found in Image 2? If yes → FIX IT.`
    };
  }

  // Default for other categories (almohadas, toallas, cubrecamas, cortinas, etc.)
  return {
    rule2: `═══════════════════════════════════════════
RULE #2 — WHAT TO CHANGE (ALL visible textile surfaces)
═══════════════════════════════════════════
Change ALL fabric/textile surfaces visible in Image 1, matching them to Image 2.

Apply the pattern/color from Image 2 to every textile product visible in Image 1:
• Pillowcases, cushion covers
• Blankets, throws, covers
• Towels, curtains
• Any other fabric product

If Image 2 shows different patterns on different pieces, match each piece accordingly.

DO NOT change:
• Non-textile elements (walls, furniture, floor, props)
• Background surfaces that are NOT part of the product
• Persons, hands, or clothing`,

    finalCheck: `═══════════════════════════════════════════
FINAL CHECK
═══════════════════════════════════════════
Before outputting, verify:
1. Is the camera angle IDENTICAL to Image 1?
2. Are the products in the SAME position as Image 1?
3. Did I add any elements that weren't in Image 1? If yes → REMOVE IT.
4. Does EVERY textile product match the pattern from Image 2?
5. Did I invent any pattern not found in Image 2? If yes → FIX IT.`
  };
}

export function buildPrompt(
  category: string,
  swatchName: string,
  colorDescription: string | null,
  shotType: string,
  isDarkSwatch: boolean = false
): string {
  const colorInfo = colorDescription ? ` (${colorDescription})` : '';
  const { rule2, finalCheck } = getCategoryRule(category);

  const darkSwatchNote = isDarkSwatch
    ? `

═══════════════════════════════════════════
CRITICAL — DARK FABRIC HANDLING
═══════════════════════════════════════════
Image 2 shows a VERY DARK fabric ("${swatchName}"${colorInfo}).
On dark fabrics, quilting/stitching patterns are naturally BARELY VISIBLE — this is correct and intentional.

MANDATORY for dark swatches:
• The output fabric color MUST be TRUE BLACK / very dark — match Image 2's darkness exactly
• Do NOT lighten the fabric to make the pattern visible — dark fabric stays dark
• The quilting texture should be EXTREMELY SUBTLE — only visible as slight shadows/highlights at fabric folds
• Match how the fabric LOOKS in Image 2: dark, uniform, with minimal visible texture
• Do NOT render the pattern prominently — on black fabric, patterns almost disappear
`
    : '';

  return `You are a photo editor specializing in textile product photography for e-commerce.

IMAGE 1 (Hero Shot): The BASE photograph that you must EDIT. This is a ${category} product shown in a ${shotType} shot.
IMAGE 2 (Swatch Reference): Shows the target color/pattern/design called "${swatchName}"${colorInfo}. Use ONLY the fabric patterns from this image. IGNORE its composition, camera angle, and scene — you only need the textile patterns.${darkSwatchNote}

═══════════════════════════════════════════
RULE #1 — COMPOSITION LOCK (HIGHEST PRIORITY)
═══════════════════════════════════════════
You are EDITING Image 1, not generating a new image. The output MUST be a faithful reproduction of Image 1 with ONLY the fabric patterns/colors changed.

MANDATORY — preserve ALL of these EXACTLY from Image 1:
• Camera angle (if top-down, output must be top-down; if 45°, output must be 45°)
• Framing and crop (same zoom level, same edges)
• Product placement and arrangement (same position, rotation, overlap of items)
• Number of items (if 2 pillows, output has exactly 2 pillows — not 1, not 3)
• Lighting direction, shadows, and highlights
• Any text, icons, infographic overlays
• Any persons, furniture, props

FORBIDDEN — do NOT do any of these:
✗ Change camera angle (e.g. cenital/top-down → 45° angled)
✗ Add elements not in Image 1 (headboard, wall, top sheet, bed frame, decorative items)
✗ Remove elements that ARE in Image 1
✗ Change the framing (wider/tighter crop)
✗ Rearrange or reposition the products
✗ Create a "bedroom scene" if Image 1 is just a flat-lay of pillows

${rule2}

═══════════════════════════════════════════
RULE #3 — PATTERN FIDELITY (from Image 2)
═══════════════════════════════════════════
Extract the fabric designs from Image 2 and apply them faithfully:
• Copy the EXACT colors — do not shift hues or saturate differently
• Copy the EXACT pattern type — if Image 2 has flowers only on borders, put flowers only on borders; if all-over, make it all-over
• Copy the EXACT density — if the pattern is sparse with lots of white space, keep it sparse; if dense, keep it dense
• Copy the EXACT motifs — do not simplify flowers into blobs, do not invent new motifs
• Do NOT invent any design element not present in Image 2

${finalCheck}

Generate at 1024x1024 resolution.`;
}

// Process jobs in the background
async function processJobs(batchId: string, projectId: string) {
  const supabase = createAdminClient();

  // Update batch to generating
  await supabase
    .from('generation_batches')
    .update({ status: 'generating', started_at: new Date().toISOString() })
    .eq('id', batchId);

  // Get project
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();

  // Get all jobs with relations
  const { data: jobs } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('batch_id', batchId)
    .eq('status', 'pending');

  if (!jobs?.length) return;

  let completedCount = 0;
  let approvedCount = 0;
  let errorCount = 0;

  for (const job of jobs) {
    try {
      // Download hero and swatch from Storage
      const [heroRes, swatchRes] = await Promise.all([
        supabase.storage.from('images').download(job.hero_shot.storage_path),
        supabase.storage.from('images').download(job.swatch.storage_path),
      ]);

      if (heroRes.error || swatchRes.error) {
        throw new Error(`Storage download failed: ${heroRes.error?.message || swatchRes.error?.message}`);
      }

      const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
      const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());
      const heroBase64 = heroBuffer.toString('base64');
      const swatchBase64 = swatchBuffer.toString('base64');

      // Detect dark swatches for prompt adjustments (no image enhancement)
      const darkSwatch = await isSwatchDark(swatchBuffer);
      if (darkSwatch) {
        console.log(`[processJobs] Dark swatch detected: "${job.swatch.name}" — using dark-fabric prompt`);
      }

      const prompt = buildPrompt(
        project?.category || 'textile',
        job.swatch.name,
        job.swatch.color_description,
        job.hero_shot.shot_type,
        darkSwatch
      );

      // Update job to generating
      await supabase
        .from('generation_jobs')
        .update({ status: 'generating', prompt_text: prompt, attempt: job.attempt + 1 })
        .eq('id', job.id);

      // Call Gemini with original swatch (dark swatches get adjusted prompt, not enhanced image)
      const result = await generateImage({
        heroImageBase64: heroBase64,
        heroMimeType: job.hero_shot.mime_type || 'image/png',
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
      });

      if (!result.success || !result.imageBase64) {
        throw new Error(result.error || 'Generation failed');
      }

      // Upload result to Storage
      const outputPath = `projects/${projectId}/generated/${job.id}.png`;
      const imageBuffer = Buffer.from(result.imageBase64, 'base64');

      await supabase.storage
        .from('images')
        .upload(outputPath, imageBuffer, {
          contentType: result.imageMimeType || 'image/png',
          upsert: true,
        });

      // Mark job as approved
      await supabase
        .from('generation_jobs')
        .update({
          status: 'approved',
          output_storage_path: outputPath,
          generation_time_ms: result.durationMs,
          gemini_model_used: process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview',
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      approvedCount++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('generation_jobs')
        .update({
          status: 'error',
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      errorCount++;
    }

    completedCount++;

    // Update batch progress
    await supabase
      .from('generation_batches')
      .update({
        completed_count: completedCount,
        approved_count: approvedCount,
        error_count: errorCount,
      })
      .eq('id', batchId);

    // Rate limit: wait between requests
    if (completedCount < jobs.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_SEC * 1000));
    }
  }

  // Finalize batch
  await supabase
    .from('generation_batches')
    .update({
      status: 'completed',
      completed_count: completedCount,
      approved_count: approvedCount,
      error_count: errorCount,
      completed_at: new Date().toISOString(),
    })
    .eq('id', batchId);
}

// GET: Return heroes with their generation status (how many jobs completed per hero)
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createAdminClient();

  // Get all heroes for this project
  const { data: heroes } = await supabase
    .from('hero_shots')
    .select('id, filename, shot_type, storage_path, display_order')
    .eq('project_id', id)
    .order('display_order');

  if (!heroes?.length) {
    return NextResponse.json([]);
  }

  // Get swatches count
  const { count: swatchCount } = await supabase
    .from('swatches')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', id);

  // Get all batches for this project
  const { data: batches } = await supabase
    .from('generation_batches')
    .select('id')
    .eq('project_id', id);

  const batchIds = batches?.map((b) => b.id) || [];

  // Get job counts per hero (across all batches)
  let jobsByHero: Record<string, { total: number; approved: number }> = {};

  if (batchIds.length > 0) {
    const { data: jobs } = await supabase
      .from('generation_jobs')
      .select('hero_shot_id, status')
      .in('batch_id', batchIds);

    if (jobs) {
      for (const job of jobs) {
        if (!jobsByHero[job.hero_shot_id]) {
          jobsByHero[job.hero_shot_id] = { total: 0, approved: 0 };
        }
        jobsByHero[job.hero_shot_id].total++;
        if (job.status === 'approved') {
          jobsByHero[job.hero_shot_id].approved++;
        }
      }
    }
  }

  const heroesWithStatus = heroes.map((hero) => ({
    ...hero,
    total_jobs: jobsByHero[hero.id]?.total || 0,
    approved_jobs: jobsByHero[hero.id]?.approved || 0,
    swatches_count: swatchCount || 0,
  }));

  return NextResponse.json(heroesWithStatus);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  // Read optional hero_ids from body
  const body = await request.json().catch(() => ({}));
  const heroIds: string[] | undefined = body.hero_ids;

  // Get project
  const { data: project, error: projError } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();

  if (projError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get heroes and swatches
  const [{ data: allHeroes }, { data: swatches }] = await Promise.all([
    supabase.from('hero_shots').select('*').eq('project_id', id).order('display_order'),
    supabase.from('swatches').select('*').eq('project_id', id).order('display_order'),
  ]);

  if (!allHeroes?.length) {
    return NextResponse.json({ error: 'No hero shots uploaded' }, { status: 400 });
  }
  if (!swatches?.length) {
    return NextResponse.json({ error: 'No swatches uploaded' }, { status: 400 });
  }

  // Filter heroes if specific ones were selected
  const selectedHeroes = heroIds?.length
    ? allHeroes.filter((h) => heroIds.includes(h.id))
    : allHeroes;

  if (!selectedHeroes.length) {
    return NextResponse.json({ error: 'No matching heroes found' }, { status: 400 });
  }

  const totalCombinations = selectedHeroes.length * swatches.length;

  // Create batch
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .insert({
      project_id: id,
      status: 'pending',
      total_combinations: totalCombinations,
      completed_count: 0,
      approved_count: 0,
      retry_count: 0,
      flagged_count: 0,
      error_count: 0,
      estimated_cost_usd: totalCombinations * COST_PER_IMAGE_USD,
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message || 'Failed to create batch' }, { status: 500 });
  }

  // Create individual jobs only for selected heroes
  const jobs = selectedHeroes.flatMap((hero) =>
    swatches!.map((swatch) => ({
      batch_id: batch.id,
      hero_shot_id: hero.id,
      swatch_id: swatch.id,
      status: 'pending' as const,
      attempt: 0,
    }))
  );

  const { error: jobsError } = await supabase
    .from('generation_jobs')
    .insert(jobs);

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  // Use after() to keep serverless function alive for background processing
  after(async () => {
    try {
      await processJobs(batch.id, id);
    } catch (err) {
      console.error('Background processing error:', err);
    }
  });

  return NextResponse.json(batch, { status: 201 });
}

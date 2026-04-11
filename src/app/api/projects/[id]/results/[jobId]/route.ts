import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark, cropSwatchToFabric, ensureOutputSpec, flattenHeroEmboss } from '@/lib/image-processing';
import { detectShotType } from '@/lib/shot-type-detector';
import {
  getCategoryStrategy,
  getEffectiveTemperature,
  buildPromptForMode,
  type GenerationMode,
} from '@/lib/category-strategy';
import { analyzeSwatchColor } from '@/lib/swatch-analyzer';
import { buildSizePromptNote } from '@/lib/size-utils';
import { getProjectSettings } from '@/lib/project-settings';
import { buildBrandPromptSection, overlayBrandLogo, chooseBestCornerByBbox, type BrandConfig } from '@/lib/brand';
import { analyzeTextElements, detectTextBboxes } from '@/lib/text-element-analyzer';
import { flattenSwatchWithAI } from '@/lib/swatch-flattener';
import { analyzeSwatchPattern } from '@/lib/swatch-planner';
import { generateSabanasMultiPass } from '@/lib/multipass-generator';
import { arePatternsSimlar } from '@/lib/pattern-comparator';
import { logPipelineEvent } from '@/lib/pipeline-log';

// Vercel serverless: max execution time (free=60s, pro=300s)
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const supabase = await createServerSupabase();
  const body = await request.json();

  const { status } = body;

  if (!['approved', 'flagged', 'retry'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const { data: job, error } = await supabase
    .from('generation_jobs')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(job);
}

// Regenerate a single job
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, jobId } = await context.params;
  const supabase = createAdminClient();

  // Parse optional body
  let mode: string | undefined;
  let forceMode: 'edit' | 'reference' | undefined;
  try {
    const body = await _request.json();
    mode = body?.mode;
    // Allow caller to force a specific generation_mode (overrides category default + auto-detect)
    if (body?.force_mode === 'edit' || body?.force_mode === 'reference') {
      forceMode = body.force_mode;
    }
  } catch {
    // No body or invalid JSON — normal regeneration
  }

  // Get job with relations
  const { data: job, error: jobError } = await supabase
    .from('generation_jobs')
    .select(`
      *,
      hero_shot:hero_shots(*),
      swatch:swatches(*)
    `)
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Get project for category + settings + brand
  const { data: project } = await supabase
    .from('projects')
    .select('category, metadata, brand_id')
    .eq('id', id)
    .single();

  // If brand_only mode, set prompt_adjustment so regenerateJob detects it
  if (mode === 'brand_only') {
    await supabase
      .from('generation_jobs')
      .update({ prompt_adjustment: 'BRAND_ONLY' })
      .eq('id', jobId);
    job.prompt_adjustment = 'BRAND_ONLY';
  } else if (job.prompt_adjustment === 'BRAND_ONLY') {
    // Clear stale BRAND_ONLY flag from previous brand attempt
    await supabase
      .from('generation_jobs')
      .update({ prompt_adjustment: null })
      .eq('id', jobId);
    job.prompt_adjustment = null;
  }

  logPipelineEvent(jobId, 'REGEN_TRIGGERED', mode || 'normal', { brand_only: mode === 'brand_only' });

  // Mark as generating (prevents QA from writing stale results)
  await supabase
    .from('generation_jobs')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  // Use after() to keep serverless function alive for background regeneration
  after(async () => {
    try {
      await regenerateJob(jobId, job, project?.category || 'textile', id, project?.metadata as Record<string, unknown> | null, project?.brand_id || null, forceMode);
    } catch (err) {
      console.error('Regeneration error:', err);
    }
  });

  return NextResponse.json({ status: 'generating' });
}

async function regenerateJob(
  jobId: string,
  job: Record<string, unknown>,
  category: string,
  projectId: string,
  projectMetadata?: Record<string, unknown> | null,
  brandId?: string | null,
  forceMode?: 'edit' | 'reference',
) {
  const supabase = createAdminClient();
  const heroShot = job.hero_shot as Record<string, string> | null;
  const swatch = job.swatch as Record<string, string>;
  const strategy = getCategoryStrategy(category);
  const projectSettings = getProjectSettings(projectMetadata);

  const qaDetail = job.qa_detail as Record<string, number> | null;
  const attempt = (job.attempt as number) || 0;
  const isBrandOnly = job.prompt_adjustment === 'BRAND_ONLY';

  try {
    const isMLImport = !heroShot;
    const existingOutput = job.output_storage_path as string;
    // Brand Gemini: use existing output (has correct pattern). Both hero+swatch = same image.
    // Normal regen: use hero original.
    // ML imports: use output (no hero exists).
    const heroPath = (isBrandOnly && existingOutput && !isMLImport)
      ? existingOutput  // Brand: use generated result (has correct pattern)
      : (heroShot?.storage_path || existingOutput);
    const swatchPath = isBrandOnly ? heroPath : swatch.storage_path;

    // Download hero and swatch FIRST (needed for shot type detection)
    const [heroRes, swatchRes] = await Promise.all([
      supabase.storage.from('images').download(heroPath),
      supabase.storage.from('images').download(swatchPath),
    ]);

    if (heroRes.error || swatchRes.error) {
      throw new Error(`Storage download failed: hero=${heroRes.error?.message}, swatch=${swatchRes.error?.message}`);
    }

    const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
    const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());

    // ── BRAND_ONLY: Try Gemini (colors + typography + text shift), fallback to Sharp (logo only) ──
    if (isBrandOnly) {
      // Use pre-brand backup if it exists (avoids accumulating logos on multiple Brand clicks)
      const preBrandPath = `projects/${projectId}/generated/${jobId}_pre_brand.png`;
      let sourcePath: string;
      let sourceBuffer: Buffer;

      const { data: preBrandData } = await supabase.storage.from('images').download(preBrandPath);
      if (preBrandData) {
        // Backup exists from previous Brand click — use it (clean version without logo)
        sourcePath = preBrandPath;
        sourceBuffer = Buffer.from(await preBrandData.arrayBuffer());
        logPipelineEvent(jobId, 'BRAND_START', 'using pre-brand backup', { source: preBrandPath });
      } else {
        // First Brand click — use existing output, then save backup before applying logo
        sourcePath = existingOutput || (isMLImport ? swatch.storage_path : heroShot?.storage_path)!;
        const { data: sourceData } = await supabase.storage.from('images').download(sourcePath);
        if (!sourceData) throw new Error('Failed to download source image for BRAND_ONLY');
        sourceBuffer = Buffer.from(await sourceData.arrayBuffer());
        // Save backup for future Brand clicks
        await supabase.storage.from('images').upload(preBrandPath, sourceBuffer, { contentType: 'image/png', upsert: true });
        logPipelineEvent(jobId, 'BRAND_START', isMLImport ? 'ML import' : 'generated', { source: sourcePath, backup_saved: true });
      }

      // Load brand
      let brand: BrandConfig | null = null;
      if (brandId) {
        const { data: brandData } = await supabase.from('brands').select('*').eq('id', brandId).single();
        if (brandData) brand = brandData as BrandConfig;
      }

      let finalBuffer: Buffer = sourceBuffer;
      let usedGemini = false;

      // ─────────────────────────────────────────────────────────────────
      // VERIFY + RETRY: try Gemini up to MAX_ATTEMPTS times. After each
      // attempt, detect text bboxes and measure overlap with the brand
      // book logo zone. If overlap > 15%, retry. Keep the best result.
      // ─────────────────────────────────────────────────────────────────
      // 2 attempts max — 3 attempts pushes against Vercel 60s timeout for difficult images
      // (each Gemini brand pass ~16-21s + bbox detection ~3s per attempt + setup)
      const MAX_ATTEMPTS = 2;
      const OVERLAP_OK = 0.15; // accept threshold
      const sourceB64 = sourceBuffer.toString('base64');

      // Pre-detect text elements once for the brand prompt
      let brandTextElements: import('@/lib/brand').TextElement[] | null = null;
      if (brand && (brand.logo_position === 'top-left' || brand.logo_position === 'top-right')) {
        try {
          const ta = await analyzeTextElements(sourceB64, 'image/png');
          if (ta?.elements?.length) {
            brandTextElements = ta.elements;
            logPipelineEvent(jobId, 'BRAND_TEXT_DETECTED', `${ta.elements.length} elements`);
          }
        } catch {}
      }

      // Build prompt — accepts an optional explicit instruction for retries
      // (e.g. "the title at coordinates X,Y must be moved").
      const buildBrandPrompt = (extraDirective?: string) => `Reproduce Image 1 preserving the product, scene, composition, background, and lighting. Do NOT change the product itself.
Image 2 is the SAME image as reference — do NOT use it to change colors or patterns.

IMPORTANT — You MUST apply the brand changes specified below:
- CHANGE all visible text colors to match the brand palette below
- CHANGE all visible text typography/fonts to match the brand fonts below
- Keep the same text content, only change COLOR and FONT

LOGO ZONE — A 200x200px logo will be added in the ${brand?.logo_position || 'top-left'} corner in post-processing. If there is text in that ${brand?.logo_position || 'top-left'} zone, MOVE that text horizontally (to the opposite side) or vertically (slightly down within the same area) to leave the ${brand?.logo_position || 'top-left'} 250x250px clear. DO NOT slide the entire image down. DO NOT crop the bottom. The image must keep its EXACT same dimensions and ALL content visible — only reposition text that overlaps with the ${brand?.logo_position || 'top-left'} corner.${extraDirective ? '\n\n' + extraDirective : ''}

CRITICAL CONSTRAINTS:
- Keep image dimensions identical (1200x1200)
- ALL elements from Image 1 must appear in the output (no cropping at edges, no missing bottom content)
- Only change: text colors, text fonts, and reposition text in the logo zone
- Do NOT change: product, scene, background, people, layout outside the logo zone
- Do NOT add: white rectangles, colored plates, background boxes, or any new graphic elements

Output: 1200x1200px, RGB, PNG.${brand ? buildBrandPromptSection(brand, 'lifestyle', brandTextElements, 'full') : ''}`;

      // Best-attempt tracking
      let bestBuffer: Buffer | null = null;
      let bestOverlap = Infinity;
      let bestAttempt = 0;
      // Carry forward bbox info from previous attempt to inject in the next prompt
      let lastFailedBboxes: Array<{ x: number; y: number; width: number; height: number; text: string }> | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          logPipelineEvent(jobId, 'BRAND_GEMINI_TRY', `attempt ${attempt}/${MAX_ATTEMPTS}`);

          // Build per-attempt prompt: on retry, inject explicit bbox coordinates
          // of the text that's blocking the logo zone — much more directive than
          // the generic "if there is text" wording, and helps Gemini move
          // elegant/serif titles it would otherwise treat as integral design.
          let extraDirective: string | undefined;
          if (attempt > 1 && lastFailedBboxes && lastFailedBboxes.length > 0) {
            const blockers = lastFailedBboxes
              .filter((bb) => {
                // Pick bboxes that visibly overlap the brand book corner
                const margin = brand?.logo_margin_px ?? 60;
                const size = brand?.logo_size_px ?? 200;
                let lx = margin;
                let ly = margin;
                if (brand?.logo_position === 'top-right') lx = 1024 - size - margin;
                const x1 = Math.max(lx, bb.x);
                const y1 = Math.max(ly, bb.y);
                const x2 = Math.min(lx + size, bb.x + bb.width);
                const y2 = Math.min(ly + size, bb.y + bb.height);
                return x2 - x1 > 0 && y2 - y1 > 0;
              })
              .slice(0, 3);
            if (blockers.length > 0) {
              const lines = blockers.map(
                (bb) => `  - "${bb.text.replace(/\s+/g, ' ').slice(0, 80)}" currently at x=${bb.x}, y=${bb.y}, width=${bb.width}, height=${bb.height}`,
              );
              extraDirective = `RETRY DIRECTIVE — The previous attempt did NOT move text out of the logo zone. The following text element(s) are CURRENTLY blocking the ${brand?.logo_position || 'top-left'} corner:
${lines.join('\n')}

You MUST RELOCATE these specific text elements so they no longer overlap the ${brand?.logo_position || 'top-left'} 250x250px corner. Move them horizontally to the right side of the image, OR shift them down below y=270. Keep their content unchanged. This is REQUIRED — do not skip this step.`;
              logPipelineEvent(jobId, 'BRAND_RETRY_DIRECTIVE', `injecting bbox directive for ${blockers.length} blocking element(s)`);
            }
          }

          const geminiResult = await generateImage({
            heroImageBase64: sourceB64,
            heroMimeType: 'image/png',
            swatchImageBase64: sourceB64,
            swatchMimeType: 'image/png',
            promptText: buildBrandPrompt(extraDirective),
            temperature: attempt === 1 ? 0.2 : 0.4, // higher temperature on retry for variation
          });

          if (!geminiResult.success || !geminiResult.imageBase64) {
            logPipelineEvent(jobId, 'BRAND_GEMINI_FAILED', `attempt ${attempt}: ${geminiResult.error || 'no image'}`);
            continue;
          }

          const geminiBuffer = Buffer.from(geminiResult.imageBase64, 'base64');
          const sharp = (await import('sharp')).default;
          const [srcMeta, gemMeta] = await Promise.all([
            sharp(sourceBuffer).metadata(),
            sharp(geminiBuffer).metadata(),
          ]);
          const srcW = srcMeta.width || 1;
          const srcH = srcMeta.height || 1;
          const gemW = gemMeta.width || 0;
          const gemH = gemMeta.height || 0;
          // Cropped if EITHER dimension fell below 70% of source
          if (gemW / srcW < 0.7 || gemH / srcH < 0.7) {
            logPipelineEvent(jobId, 'BRAND_GEMINI_CROP_DETECTED', `attempt ${attempt}: ${gemW}x${gemH} vs ${srcW}x${srcH}`);
            continue;
          }

          // CRITICAL: verify on the SAME pixel space we will use for the overlay.
          // ensureOutputSpec resizes the Gemini buffer to 1200x1200. The bbox
          // detection MUST run on the resized buffer, otherwise Gemini Flash may
          // miss text on the smaller raw output and report a false 0% overlap
          // even when the title is clearly at top-left.
          const resizedBuffer = await ensureOutputSpec(geminiBuffer, 1200);
          const resizedMeta = await sharp(resizedBuffer).metadata();
          const rW = resizedMeta.width || 1200;
          const rH = resizedMeta.height || 1200;

          // Verify: detect text bboxes and measure overlap with brand book logo zone
          let attemptOverlap = 0;
          let attemptBboxes: Array<{ x: number; y: number; width: number; height: number; text: string }> | null = null;
          if (brand) {
            try {
              const detected = await detectTextBboxes(
                resizedBuffer.toString('base64'),
                'image/png',
                rW,
                rH,
              );
              if (detected && detected.length > 0) {
                attemptBboxes = detected;
                const choice = chooseBestCornerByBbox(rW, rH, brand, detected);
                const brandBookEntry = choice.allCorners.find((c) => c.corner === brand.logo_position);
                attemptOverlap = brandBookEntry ? brandBookEntry.overlap : 0;
              }
            } catch (err) {
              console.error(`[brand] attempt ${attempt} bbox detection failed:`, err);
            }
          }
          // Save bboxes from this attempt to feed into the next attempt's prompt
          lastFailedBboxes = attemptBboxes;

          // Log a sample bbox so we can see what Gemini detected (debugging false negatives)
          const bboxSample = attemptBboxes && attemptBboxes.length > 0
            ? `${attemptBboxes.length} bboxes, first="${attemptBboxes[0].text.replace(/\s+/g, ' ').slice(0, 40)}" at (${attemptBboxes[0].x},${attemptBboxes[0].y},${attemptBboxes[0].width}x${attemptBboxes[0].height})`
            : 'no bboxes';
          logPipelineEvent(jobId, 'BRAND_VERIFY', `attempt ${attempt}: ${rW}x${rH}, overlap ${(attemptOverlap * 100).toFixed(0)}% [${bboxSample}]`);

          // Track best result so far — store the RESIZED buffer (already 1200x1200)
          if (attemptOverlap < bestOverlap) {
            bestOverlap = attemptOverlap;
            bestBuffer = resizedBuffer;
            bestAttempt = attempt;
          }

          // Accept if overlap is below threshold
          if (attemptOverlap <= OVERLAP_OK) {
            logPipelineEvent(jobId, 'BRAND_VERIFY_PASS', `attempt ${attempt} accepted (overlap ${(attemptOverlap * 100).toFixed(0)}%)`);
            break;
          }

          // Otherwise retry (unless this was the last attempt)
          if (attempt < MAX_ATTEMPTS) {
            logPipelineEvent(jobId, 'BRAND_VERIFY_RETRY', `attempt ${attempt} overlap ${(attemptOverlap * 100).toFixed(0)}% > ${OVERLAP_OK * 100}% — retrying`);
          }
        } catch (geminiErr) {
          logPipelineEvent(jobId, 'BRAND_GEMINI_ERROR', `attempt ${attempt}: ${geminiErr instanceof Error ? geminiErr.message : 'unknown'}`);
        }
      }

      if (bestBuffer) {
        finalBuffer = bestBuffer; // already 1200x1200 from per-attempt resize
        usedGemini = true;
        logPipelineEvent(jobId, 'BRAND_GEMINI_OK', `chosen attempt ${bestAttempt} (overlap ${(bestOverlap * 100).toFixed(0)}%)`);
      } else {
        finalBuffer = await ensureOutputSpec(sourceBuffer, 1200);
        logPipelineEvent(jobId, 'BRAND_GEMINI_FALLBACK', 'all attempts failed — using source');
      }

      // Logo ALWAYS at brand book position (finalBuffer is already 1200x1200)
      let imageBuffer = finalBuffer;
      if (brand) {
        imageBuffer = Buffer.from(await overlayBrandLogo(imageBuffer, brand, 'lifestyle', null, brand.logo_position));
        logPipelineEvent(jobId, 'BRAND_OVERLAY', brand.name, { corner: brand.logo_position, final_overlap_pct: Math.round(bestOverlap * 100) });
      }

      const outputPath = `projects/${projectId}/generated/${jobId}.png`;
      await supabase.storage.from('images').upload(outputPath, imageBuffer, { contentType: 'image/png', upsert: true });
      logPipelineEvent(jobId, 'UPLOAD', outputPath);
      await supabase.from('generation_jobs').update({
        status: 'approved',
        output_storage_path: outputPath,
        generation_time_ms: 0,
        gemini_model_used: usedGemini ? 'gemini-brand' : 'sharp-only',
        attempt: attempt + 1,
        qa_score: 0.95,
        qa_feedback: usedGemini ? 'Auto-approved (BRAND_ONLY Gemini)' : 'Auto-approved (BRAND_ONLY Sharp fallback)',
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      logPipelineEvent(jobId, 'STATUS', 'approved', { method: usedGemini ? 'gemini' : 'sharp-fallback' });
      return;
    }

    // ML imports cannot be regenerated with Gemini — they're pre-imported MercadoLibre photos
    // with no hero shot. Return as-is (already approved).
    if (isMLImport) {
      logPipelineEvent(jobId, 'ML_IMPORT_SKIP', 'cannot regenerate ML imports');
      await supabase.from('generation_jobs').update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      return;
    }

    // Auto-detect shot type — use cache, skip for BRAND_ONLY
    let effectiveShotType = heroShot ? ((heroShot as Record<string, unknown>).detected_shot_type as string || heroShot.shot_type || 'lifestyle') : 'lifestyle';
    if (isBrandOnly || !heroShot) {
      // BRAND_ONLY or ML-imported (no hero): skip detection entirely
    } else if (!(heroShot as Record<string, unknown>).detected_shot_type) {
      const heroBase64ForDetection = heroBuffer.toString('base64');
      try {
        const detection = await detectShotType(heroBase64ForDetection, heroShot.mime_type || 'image/png');
        if (detection && detection.confidence >= 0.7 && detection.detected_type !== effectiveShotType) {
          console.log(
            `[regenerateJob] Shot type override: "${effectiveShotType}" → "${detection.detected_type}" ` +
            `(confidence: ${(detection.confidence * 100).toFixed(0)}%)`
          );
          effectiveShotType = detection.detected_type;
        }
        supabase.from('hero_shots').update({ detected_shot_type: effectiveShotType }).eq('id', heroShot.id).then(() => {});
      } catch (err) {
        console.error('[regenerateJob] Shot type detection failed:', err);
      }
    }

    logPipelineEvent(jobId, 'SHOT_TYPE', effectiveShotType, { cached: !!(heroShot as Record<string, unknown>)?.detected_shot_type });

    // Determine mode — auto-detect edit vs reference by comparing patterns
    let mode: GenerationMode = strategy.generation_mode;
    if (forceMode) {
      mode = forceMode;
      console.log(`[regenerateJob] Mode forced via API: ${mode}`);
      logPipelineEvent(jobId, 'MODE_FORCED', mode, { source: 'api_param' });
    } else if (!isBrandOnly) {
      if (effectiveShotType === 'detail' || effectiveShotType === 'infografia') {
        mode = 'edit';
        console.log(`[regenerateJob] ${effectiveShotType} shot detected — forcing edit mode`);
      } else if (qaDetail?.hero_contamination && qaDetail.hero_contamination > 0.6 && strategy.retry_escalation) {
        mode = strategy.retry_escalation;
        console.log(`[regenerateJob] Hero contamination — escalating to ${mode}`);
      } else if (mode === 'reference') {
        // Auto-detect: if hero and swatch have similar patterns, use edit (color change only)
        try {
          const heroB64 = heroBuffer.toString('base64');
          const swatchB64 = swatchBuffer.toString('base64');
          const similar = await arePatternsSimlar(heroB64, heroShot?.mime_type || 'image/png', swatchB64, 'image/png');
          if (similar) {
            mode = 'edit';
            console.log(`[regenerateJob] Patterns similar → edit mode (color change only)`);
          }
        } catch (err) {
          console.error('[regenerateJob] Pattern comparison failed:', err);
        }
      }
    }

    const temperature = isBrandOnly ? 0.2 : getEffectiveTemperature(strategy, mode, attempt);

    logPipelineEvent(jobId, 'MODE_SELECTED', mode as string, { temperature, attempt });

    // Detect dark swatches for prompt adjustments (skip for BRAND_ONLY)
    const darkSwatch = isBrandOnly ? false : await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[regenerateJob] Dark swatch detected: "${swatch.name}"`);
    }

    // ── Auto-analyze swatch color if missing (skip for BRAND_ONLY — saves ~2s) ──
    // Use short color description only (not planner's long analysis)
    const rawColorDesc = swatch.color_description;
    let swatchColorDescription: string | null = (rawColorDesc && rawColorDesc.length <= 100) ? rawColorDesc : null;
    if (!swatchColorDescription) swatchColorDescription = swatch.name;
    if (!rawColorDesc && !isBrandOnly) {
      console.log(`[regenerateJob] Swatch "${swatch.name}" has no color_description — auto-analyzing...`);
      try {
        const colorAnalysis = await analyzeSwatchColor(
          swatchBuffer.toString('base64'),
          swatch.mime_type || 'image/png'
        );
        if (colorAnalysis) {
          swatchColorDescription = colorAnalysis.colorDescription;
          console.log(`[regenerateJob] Auto-detected color: "${swatchColorDescription}"`);
          Promise.resolve(
            supabase
              .from('swatches')
              .update({
                color_description: colorAnalysis.colorDescription,
                dominant_color_hex: colorAnalysis.dominantHex,
              })
              .eq('id', swatch.id)
          ).catch((err: unknown) => console.error('[regenerateJob] Failed to cache swatch color:', err));
        }
      } catch (err) {
        console.error('[regenerateJob] Swatch color analysis failed:', err);
      }
    }

    // ── Get QA feedback from previous attempt ──
    const qaFeedback = (job.qa_feedback as string) || null;
    if (qaFeedback) {
      console.log(`[regenerateJob] Using QA feedback: "${qaFeedback}"`);
    }

    // Preprocessing (skip for BRAND_ONLY — image stays unchanged)
    let swatchBase64 = swatchBuffer.toString('base64');
    if (!isBrandOnly && strategy.preprocessing.crop_swatch) {
      const croppedSwatch = await cropSwatchToFabric(swatchBuffer);
      swatchBase64 = croppedSwatch.toString('base64');
    }

    // Save cropped swatch before AI flatten — verifier needs the real texture
    const swatchBase64ForVerification = swatchBase64;

    // Skip AI flatten on retries — the flattener may have introduced wrong patterns
    const skipFlatten = qaFeedback != null;
    if (skipFlatten && strategy.preprocessing.flatten_swatch_ai) {
      console.log(`[regenerateJob] Skipping AI flatten on retry — using cropped swatch`);
    }

    // AI-based swatch flattening — generates flat pattern view for detailed textiles
    if (strategy.preprocessing.flatten_swatch_ai && !isBrandOnly && !skipFlatten) {
      // Check cache first: look for flat version in swatch_images
      const { data: flatCache } = await supabase
        .from('swatch_images')
        .select('storage_path')
        .eq('swatch_id', swatch.id)
        .eq('label', 'flat')
        .limit(1)
        .single();

      if (flatCache?.storage_path) {
        // Use cached flat swatch
        const { data: flatData } = await supabase.storage.from('images').download(flatCache.storage_path);
        if (flatData) {
          const flatBuffer = Buffer.from(await flatData.arrayBuffer());
          swatchBase64 = flatBuffer.toString('base64');
          console.log(`[regenerateJob] Using cached flat swatch for ${swatch.name}`);
        }
      } else {
        // Generate flat swatch with AI
        console.log(`[regenerateJob] Generating flat swatch for ${swatch.name}...`);
        const flatBuffer = await flattenSwatchWithAI(
          swatchBase64,
          'image/png',
          swatch.color_description || undefined
        );
        if (flatBuffer) {
          swatchBase64 = flatBuffer.toString('base64');
          // Cache for future jobs (non-blocking)
          const flatPath = `projects/${projectId}/swatches/${swatch.id}_flat.png`;
          supabase.storage.from('images').upload(flatPath, flatBuffer, { contentType: 'image/png', upsert: true }).then(({ error }) => {
            if (!error) {
              supabase.from('swatch_images').insert({
                id: crypto.randomUUID(),
                swatch_id: swatch.id,
                storage_path: flatPath,
                label: 'flat',
                file_size_kb: Math.round(flatBuffer.length / 1024),
                display_order: 99,
              }).then(() => {});
            }
          });
          console.log(`[regenerateJob] Flat swatch generated and cached for ${swatch.name}`);
        } else {
          console.log(`[regenerateJob] Flat swatch generation failed, using cropped swatch`);
        }
      }
    }

    // ── Swatch Pattern Analysis (Planner) — describes pattern for generation prompt ──
    let swatchPatternDescription: string | null = null;
    if (!isBrandOnly) {
      // Use cached analysis from swatch.color_description if it's detailed enough (>100 chars)
      const cached = swatch.color_description;
      if (cached && cached.length > 100) {
        swatchPatternDescription = cached;
        console.log(`[regenerateJob] Using cached swatch pattern analysis for ${swatch.name}`);
      } else {
        swatchPatternDescription = await analyzeSwatchPattern(
          swatchBase64,
          'image/png',
          swatch.name,
        );
        if (swatchPatternDescription) {
          // Cache pattern analysis — only if no short color desc exists yet
          const existing = swatch.color_description;
          if (!existing || existing.length > 100) {
            supabase.from('swatches')
              .update({ color_description: swatchPatternDescription })
              .eq('id', swatch.id)
              .then(() => {});
          }
        }
      }
    }

    // Build prompt — use BRAND_ONLY prompt if original job was BRAND_ONLY
    let prompt: string;

    if (isBrandOnly) {
      prompt = `Reproduce Image 1 preserving the product, scene, composition, background, and lighting. Do NOT change the product itself.

Image 2 is the SAME image as reference — do NOT use it to change colors or patterns.

IMPORTANT — You MUST apply the brand changes specified below:
- CHANGE all visible text colors to match the brand palette below
- CHANGE all visible text typography/fonts to match the brand fonts below
- Keep the same text content, only change COLOR and FONT
These changes are MANDATORY, not optional.

Everything else (product, background, people, objects) must remain as in Image 1.

Output: ${projectSettings.generation.resolution}px, RGB, PNG.`;
      console.log(`[regenerateJob] BRAND_ONLY mode — reproducing image with brand guidelines`);
    } else {
      prompt = buildPromptForMode(
        mode,
        strategy,
        swatch.name,
        swatchColorDescription,
        effectiveShotType,
        darkSwatch,
        qaFeedback,
        projectSettings.generation.resolution
      );
    }

    // NOTE: swatch pattern description is NOT injected into the generation prompt.
    // The visual swatch image is the sole reference — text descriptions cause Gemini
    // to "interpret" rather than copy. The description is used by the verifier (2.5 Pro) only.

    // Add brand guidelines if project has a brand
    let brand: BrandConfig | null = null;
    let textElements: import('@/lib/brand').TextElement[] | null = null;
    if (brandId) {
      const { data: brandData } = await supabase
        .from('brands')
        .select('*')
        .eq('id', brandId)
        .single();
      if (brandData) {
        brand = brandData as BrandConfig;

        // Detect text elements — use cache from hero_shots if available
        if (brand.typography || brand.primary_color || brand.secondary_color || brand.accent_color) {
          // Read cache directly from job data (avoid type cast issues)
          const heroData = job.hero_shot as Record<string, unknown>;
          const cachedElements = heroData?.text_elements;
          console.log(`[regenerateJob] text_elements cache: ${cachedElements ? JSON.stringify(cachedElements).substring(0, 100) : 'null'}`);

          if (cachedElements && Array.isArray(cachedElements) && cachedElements.length > 0) {
            textElements = cachedElements as import('@/lib/brand').TextElement[];
            console.log(`[regenerateJob] Using ${textElements.length} cached text elements`);
          } else {
            try {
              const heroB64 = heroBuffer.toString('base64');
              const textAnalysis = await analyzeTextElements(heroB64, heroShot?.mime_type || 'image/png');
              if (textAnalysis?.elements?.length) {
                textElements = textAnalysis.elements;
                console.log(`[regenerateJob] Detected ${textElements.length} text elements (caching)`);
                if (heroShot?.id) {
                  supabase.from('hero_shots').update({ text_elements: textElements }).eq('id', heroShot.id).then(() => {});
                }
              }
            } catch (err) {
              console.error('[regenerateJob] Text analysis failed (non-blocking):', err);
            }
          }
        }

        // Inject brand prompt: 'full' for BRAND_ONLY (includes logo prohibition), 'light' for normal (colors + typography only)
        const brandMode = isBrandOnly ? 'full' : 'light';
        const brandSection = buildBrandPromptSection(brand, effectiveShotType, textElements, brandMode);

        // Logo shift instruction REMOVED — it causes Gemini to slide content down
        // and crop the bottom of the image. Sharp overlays the logo without moving text.

        prompt += brandSection;
        console.log(`[regenerateJob] Brand loaded: ${brand.name}`);
      }
    }

    // Add size-aware note for 1P/1.5P bed products (skip for BRAND_ONLY)
    const sizeNote = !isBrandOnly ? buildSizePromptNote(swatch.sku_suffix, category) : null;
    if (sizeNote) {
      prompt += sizeNote;
      console.log(`[regenerateJob] Size adjustment for SKU ${swatch.sku_suffix}`);
    }

    const promptMetadata: Record<string, unknown> = {
      strategy: mode,
      category,
      attempt,
      temperature,
      dark_swatch: darkSwatch,
      crop_swatch: strategy.preprocessing.crop_swatch,
      flatten_swatch_ai: strategy.preprocessing.flatten_swatch_ai || false,
      swatch_color: swatchColorDescription,
      qa_feedback_used: qaFeedback ? true : false,
      manual_regeneration: true,
      detected_shot_type: effectiveShotType,
      swatch_pattern_analyzed: !!swatchPatternDescription,
    };

    // Generate — escalate to Pro model. Quilts escalate earlier (Flash can't reproduce fine textures)
    const proThreshold = category === 'quilts' ? 1 : 2;
    const useProModel = attempt >= proThreshold;

    logPipelineEvent(jobId, 'GENERATION_START', useProModel ? 'Pro' : 'Flash', {
      temperature, mode: mode as string, brand: brand?.name || null,
    });

    let result: { success: boolean; imageBase64?: string; imageMimeType?: string; error?: string; durationMs: number } | undefined;

    // ── Multi-pass generation for sabanas (DISABLED — single-pass Pro gives better results) ──
    if (false && category === 'sabanas' && mode === 'edit') {
      console.log(`[regenerateJob] Using multi-pass generation for sabanas`);
      const heroBase64 = heroBuffer.toString('base64');
      const multiResult = await generateSabanasMultiPass(
        heroBase64,
        heroShot?.mime_type || 'image/png',
        swatchBase64,
        'image/png',
        swatchBuffer,
        temperature,
        useProModel,
      );
      if (multiResult.success && multiResult.imageBuffer) {
        result = {
          success: true,
          imageBase64: multiResult.imageBuffer!.toString('base64'),
          imageMimeType: 'image/png',
          durationMs: 0,
        };
        promptMetadata.multipass = true;
        promptMetadata.multipass_passes = multiResult.passes;
        console.log(`[regenerateJob] Multi-pass complete: ${multiResult.passes} passes`);
      } else {
        console.log(`[regenerateJob] Multi-pass failed (${multiResult.error}), falling back to single-pass`);
      }
    }

    // ── Normal single-pass generation (or fallback from multi-pass) ──
    if (!result) {
      if (mode === 'from_scratch') {
        result = await generateImage({
          swatchImageBase64: swatchBase64,
          swatchMimeType: 'image/png',
          promptText: prompt,
          temperature,
          useProModel,
        });
      } else {
        // If strategy enables flatten_hero (e.g. quilts), pre-process the hero
        // through Sharp to remove its 3D relief (waffle dots, channel stitching)
        // BEFORE sending to Gemini. This prevents hero texture bleeding into
        // the result when the swatch is a flat printed pattern.
        let heroBufferForGen: Buffer = heroBuffer;
        if (strategy.preprocessing.flatten_hero) {
          try {
            const flattened = await flattenHeroEmboss(heroBuffer);
            heroBufferForGen = Buffer.from(flattened);
            logPipelineEvent(jobId, 'HERO_FLATTENED', 'pre-generation Sharp flatten', { mode });
          } catch (err) {
            console.error('[regenerateJob] flattenHeroEmboss failed:', err);
          }
        }
        const heroBase64 = heroBufferForGen.toString('base64');
        result = await generateImage({
          heroImageBase64: heroBase64,
          heroMimeType: heroShot?.mime_type || 'image/png',
          swatchImageBase64: swatchBase64,
          swatchMimeType: 'image/png',
          promptText: prompt,
          temperature,
          useProModel,
        });
      }
    }

    if (!result.success || !result.imageBase64) {
      logPipelineEvent(jobId, 'GENERATION_DONE', 'failed', { error: result.error, duration_ms: result.durationMs });
      throw new Error(result.error || 'Generation failed');
    }

    logPipelineEvent(jobId, 'GENERATION_DONE', 'success', { duration_ms: result.durationMs });

    // Post-process: ensure 1200x1200 sRGB
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    let imageBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // Brand post-processing: logo ALWAYS at brand book position
    if (brand) {
      try {
        imageBuffer = await overlayBrandLogo(imageBuffer, brand, effectiveShotType, null, brand.logo_position);
        logPipelineEvent(jobId, 'BRAND_OVERLAY', brand.name, { corner: brand.logo_position });
      } catch (brandErr) {
        logPipelineEvent(jobId, 'BRAND_OVERLAY', 'failed', { error: String(brandErr) });
        console.error('[regenerateJob] Brand processing failed (non-blocking):', brandErr);
      }
    }

    // ── Swatch Fidelity Verification (Gemini 2.5 Pro) — blocks bad images ──
    // Skip for multi-pass (each pass is targeted, verification would exceed 60s timeout)
    const isMultiPass = !!promptMetadata.multipass;
    if (!isBrandOnly && !isMultiPass) {
      try {
        const { verifySwatch } = await import('@/lib/swatch-verifier');
        const generatedB64 = imageBuffer.toString('base64');
        // Use cropped (pre-flatten) swatch — AI flattener can misinterpret textures
        const verification = await verifySwatch(
          swatchBase64ForVerification,
          generatedB64,
          heroBuffer.toString('base64'),
          swatch.name,
          swatchPatternDescription,
        );
        if (verification) {
          promptMetadata.verification_score = verification.score;
          promptMetadata.verification_pass = verification.pass;
          promptMetadata.verification_issues = verification.issues;
          if (!verification.pass && attempt < 4) {
            // BLOCK: verification failed — delegate retry to process-next chain
            const feedback = verification.feedback || verification.issues.join('. ');
            logPipelineEvent(jobId, 'VERIFICATION', 'FAIL', { score: verification.score, issues: verification.issues });
            logPipelineEvent(jobId, 'VERIFICATION_RETRY', feedback, { new_attempt: attempt + 1 });
            console.log(`[regenerateJob] ⚠ Verification BLOCKED (score: ${verification.score}): ${feedback} — delegating to process-next`);
            await supabase.from('generation_jobs').update({
              status: 'pending',
              qa_feedback: `[Verifier 2.5 Pro] ${feedback}`,
              attempt: attempt + 1,
              prompt_metadata: promptMetadata,
              updated_at: new Date().toISOString(),
            }).eq('id', jobId);
            // Trigger process-next chain to pick up this pending job
            const batchId = job.batch_id as string;
            if (batchId) {
              const baseUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}` || 'http://localhost:3000';
              fetch(`${baseUrl}/api/batches/${batchId}/process-next`, { method: 'POST' }).catch(() => {});
              console.log(`[regenerateJob] Triggered process-next for batch ${batchId}`);
            }
            return;
          } else if (!verification.pass) {
            logPipelineEvent(jobId, 'VERIFICATION', 'FAIL_MAX_RETRIES', { score: verification.score, feedback: verification.feedback });
            console.log(`[regenerateJob] ⚠ Verification FAILED (max retries): ${verification.feedback}`);
            promptMetadata.verification_feedback = verification.feedback;
          } else {
            logPipelineEvent(jobId, 'VERIFICATION', 'PASS', { score: verification.score });
            console.log(`[regenerateJob] ✓ Verification passed (score: ${verification.score})`);
          }
        }
      } catch (verifyErr) {
        console.error('[regenerateJob] Verification failed (non-blocking):', verifyErr);
      }
    }

    // Upload result
    const outputPath = `projects/${projectId}/generated/${jobId}.png`;

    await supabase.storage
      .from('images')
      .upload(outputPath, imageBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    logPipelineEvent(jobId, 'UPLOAD', outputPath);

    // BRAND_ONLY: auto-approve (skip QA). Regular: send to QA.
    const finalStatus = isBrandOnly ? 'approved' : 'qa_pending';

    await supabase
      .from('generation_jobs')
      .update({
        status: finalStatus,
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        gemini_model_used: useProModel ? (process.env.GEMINI_MODEL_PRO || 'gemini-3.1-pro-preview') : (process.env.GEMINI_MODEL || 'gemini-3.1-flash-image-preview'),
        attempt: attempt + 1,
        prompt_text: prompt,
        prompt_metadata: promptMetadata,
        updated_at: new Date().toISOString(),
        ...(isBrandOnly ? { qa_score: 0.95, qa_feedback: 'Auto-approved (BRAND_ONLY)' } : {}),
      })
      .eq('id', jobId);

    logPipelineEvent(jobId, 'STATUS', finalStatus, { qa_triggered: !isBrandOnly });

    // Trigger QA for this job (skip for BRAND_ONLY — already approved)
    if (isBrandOnly) {
      console.log(`[regenerateJob] BRAND_ONLY — auto-approved, skipping QA`);
    }

    const baseUrl = process.env.APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
      || 'http://localhost:3000';

    const batchId = job.batch_id as string;
    if (batchId && !isBrandOnly) {
      try {
        await fetch(`${baseUrl}/api/batches/${batchId}/process-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        console.log(`[regenerateJob] Triggered QA for batch ${batchId}`);
      } catch (err) {
        console.error('[regenerateJob] Failed to trigger QA:', err);
      }
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logPipelineEvent(jobId, 'ERROR', errorMessage);

    await supabase
      .from('generation_jobs')
      .update({
        status: 'error',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

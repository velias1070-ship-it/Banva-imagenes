import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateImage } from '@/lib/gemini/client';
import { isSwatchDark, cropSwatchToFabric, ensureOutputSpec } from '@/lib/image-processing';
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
import { buildBrandPromptSection, overlayBrandLogo, clearLogoZone, type BrandConfig } from '@/lib/brand';
import { analyzeTextElements } from '@/lib/text-element-analyzer';

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

  // Mark as generating (prevents QA from writing stale results)
  await supabase
    .from('generation_jobs')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  // Use after() to keep serverless function alive for background regeneration
  after(async () => {
    try {
      await regenerateJob(jobId, job, project?.category || 'textile', id, project?.metadata as Record<string, unknown> | null, project?.brand_id || null);
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
  brandId?: string | null
) {
  const supabase = createAdminClient();
  const heroShot = job.hero_shot as Record<string, string>;
  const swatch = job.swatch as Record<string, string>;
  const strategy = getCategoryStrategy(category);
  const projectSettings = getProjectSettings(projectMetadata);

  const qaDetail = job.qa_detail as Record<string, number> | null;
  const attempt = (job.attempt as number) || 0;

  try {
    // Download hero and swatch FIRST (needed for shot type detection)
    const [heroRes, swatchRes] = await Promise.all([
      supabase.storage.from('images').download(heroShot.storage_path),
      supabase.storage.from('images').download(swatch.storage_path),
    ]);

    if (heroRes.error || swatchRes.error) {
      throw new Error(`Storage download failed`);
    }

    const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
    const swatchBuffer = Buffer.from(await swatchRes.data.arrayBuffer());
    const isBrandOnly = job.prompt_adjustment === 'BRAND_ONLY';

    // Auto-detect shot type — use cache, skip for BRAND_ONLY
    let effectiveShotType = (heroShot as Record<string, unknown>).detected_shot_type as string || heroShot.shot_type || 'lifestyle';
    if (isBrandOnly) {
      // BRAND_ONLY: skip detection entirely
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

    // Determine mode — detail/infografia shots ALWAYS use edit (reference invents scenes)
    let mode: GenerationMode = strategy.generation_mode;
    if (!isBrandOnly) {
      if (effectiveShotType === 'detail' || effectiveShotType === 'infografia') {
        mode = 'edit';
        console.log(`[regenerateJob] ${effectiveShotType} shot detected — forcing edit mode`);
      } else if (qaDetail?.hero_contamination && qaDetail.hero_contamination > 0.6 && strategy.retry_escalation) {
        mode = strategy.retry_escalation;
        console.log(`[regenerateJob] Hero contamination — escalating to ${mode}`);
      } else if (attempt > 0 && strategy.retry_escalation) {
        mode = strategy.retry_escalation;
        console.log(`[regenerateJob] Retry attempt ${attempt} — using ${mode}`);
      }
    }

    const temperature = isBrandOnly ? 0.2 : getEffectiveTemperature(strategy, mode, attempt);

    // Detect dark swatches for prompt adjustments (skip for BRAND_ONLY)
    const darkSwatch = isBrandOnly ? false : await isSwatchDark(swatchBuffer);
    if (darkSwatch) {
      console.log(`[regenerateJob] Dark swatch detected: "${swatch.name}"`);
    }

    // ── Auto-analyze swatch color if missing (skip for BRAND_ONLY — saves ~2s) ──
    let swatchColorDescription = swatch.color_description || null;
    if (!swatchColorDescription && !isBrandOnly) {
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
              const textAnalysis = await analyzeTextElements(heroB64, heroShot.mime_type || 'image/png');
              if (textAnalysis?.elements?.length) {
                textElements = textAnalysis.elements;
                console.log(`[regenerateJob] Detected ${textElements.length} text elements (caching)`);
                supabase.from('hero_shots').update({ text_elements: textElements }).eq('id', heroShot.id).then(() => {});
              }
            } catch (err) {
              console.error('[regenerateJob] Text analysis failed (non-blocking):', err);
            }
          }
        }

        const brandSection = buildBrandPromptSection(brand, effectiveShotType, textElements);

        // If text overlaps logo zone, prepend shift instruction to START of prompt
        const hasTopText = textElements?.some(el => el.position === 'top');
        const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
        if (hasTopText && logoAtTop && isBrandOnly) {
          const clearSpace = brand.logo_size_px + brand.logo_margin_px + 10;
          const side = brand.logo_position === 'top-left' ? 'left' : 'right';
          const topTexts = textElements!.filter(el => el.position === 'top').map(el => `"${el.text}"`).join(', ');
          prompt = `FIRST PRIORITY: A ${brand.logo_size_px}px logo goes at top-${side}. Move ALL text in the top ${clearSpace}px down below that line. Texts to move: ${topTexts}. Do NOT add white boxes or backgrounds — keep the natural image background. Do NOT invent new text.\n\n${prompt}`;
          console.log(`[regenerateJob] Prepended shift instruction for ${textElements!.filter(el => el.position === 'top').length} top texts`);
        }

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
      swatch_color: swatchColorDescription,
      qa_feedback_used: qaFeedback ? true : false,
      manual_regeneration: true,
      detected_shot_type: effectiveShotType,
    };

    // Generate
    let result;

    if (mode === 'from_scratch') {
      result = await generateImage({
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature,
      });
    } else {
      const heroBase64 = heroBuffer.toString('base64');
      result = await generateImage({
        heroImageBase64: heroBase64,
        heroMimeType: heroShot.mime_type || 'image/png',
        swatchImageBase64: swatchBase64,
        swatchMimeType: 'image/png',
        promptText: prompt,
        temperature,
      });
    }

    if (!result.success || !result.imageBase64) {
      throw new Error(result.error || 'Generation failed');
    }

    // Post-process: ensure 1200x1200 sRGB
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    let imageBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // Brand post-processing: shift overlapping text + overlay logo
    if (brand) {
      try {
        imageBuffer = await clearLogoZone(imageBuffer, brand, textElements);
        imageBuffer = await overlayBrandLogo(imageBuffer, brand, effectiveShotType, textElements);
      } catch (brandErr) {
        console.error('[regenerateJob] Brand processing failed (non-blocking):', brandErr);
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

    // BRAND_ONLY: auto-approve (skip QA). Regular: send to QA.
    const finalStatus = isBrandOnly ? 'approved' : 'qa_pending';

    await supabase
      .from('generation_jobs')
      .update({
        status: finalStatus,
        output_storage_path: outputPath,
        generation_time_ms: result.durationMs,
        attempt: attempt + 1,
        prompt_text: prompt,
        prompt_metadata: promptMetadata,
        updated_at: new Date().toISOString(),
        ...(isBrandOnly ? { qa_score: 0.95, qa_feedback: 'Auto-approved (BRAND_ONLY)' } : {}),
      })
      .eq('id', jobId);

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

import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { type GeminiGenerateResult } from '@/lib/gemini/client';
import { generateImageSmart } from '@/lib/image-providers';
import { isSwatchDark, cropSwatchToFabric, cropAndTileSwatchToFabric, flattenHeroEmboss, ensureOutputSpec, createSwatchCollage, computeSwatchOutputDeltaE, compositeHeroOverlays } from '@/lib/image-processing';
import {
  getCategoryStrategy,
  getEffectiveMode,
  getEffectiveTemperature,
  buildPromptForMode,
} from '@/lib/category-strategy';
import { analyzeSwatchColor } from '@/lib/swatch-analyzer';
import { buildSizePromptNote } from '@/lib/size-utils';
import { detectShotType } from '@/lib/shot-type-detector';
import { getProjectSettings } from '@/lib/project-settings';
import { getProjectBrand, buildBrandPromptSection, overlayBrandLogo, chooseBestCornerByBbox, type BrandConfig } from '@/lib/brand';
import { detectTextBboxes } from '@/lib/text-element-analyzer';
import { analyzeTextElements } from '@/lib/text-element-analyzer';
import { flattenSwatchWithAI } from '@/lib/swatch-flattener';
import { analyzeSwatchPattern } from '@/lib/swatch-planner';
import { verifySwatch } from '@/lib/swatch-verifier';
import { generateSabanasMultiPass } from '@/lib/multipass-generator';
import { arePatternsSimlar } from '@/lib/pattern-comparator';
import { buildCaseSignature } from '@/lib/case-signature';
import { sumJobCostFromPipelineLog, evaluateCostCap, getCostCapForCategory } from '@/lib/cost-cap';
import { selectModelId } from '@/lib/image-providers';
import { MODEL_REGISTRY } from '@/lib/models/registry';
import { detectStripeVisualAxis, hasDirectionalPattern, type StripeVisualAxis } from '@/lib/bed-camera-angle';
import { MAX_QA_RETRIES } from '@/lib/constants';
import { logPipelineEvent } from '@/lib/pipeline-log';

// Vercel Pro: max 300s. Needed for GPT Image 2 fallback (~140s) + verifier + upload.
// One job per invocation — Gemini ~25s, GPT-2 ~145s, upload+verifier ~20s.
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * Reliable chain invocation with retry.
 * Awaits the fetch with a timeout so we KNOW if it succeeded.
 * If it fails, retries once. Returns true if the request was dispatched.
 */
async function reliableFetch(url: string, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status < 500) {
        return true;
      }
      console.error(`[process-next] ${label} returned ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      console.error(`[process-next] ${label} fetch failed (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
    }
  }
  return false;
}

/**
 * CADENA 1 — GENERATION CHAIN
 * Process ONE pending job from a batch, then self-invoke for the next.
 * Does NOT do QA — generates, uploads, sets status=qa_pending, chains.
 * After EACH job → triggers QA chain so both run in parallel.
 *
 * ARCHITECTURE: Heavy work (Gemini API) runs BEFORE the response.
 * Chain continuation uses awaited fetch with retry + after() backup.
 *
 * CHAIN RELIABILITY: The chain MUST NOT silently stop. Every exit path
 * either chains to the next job or logs exactly why it stopped.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { batchId } = await context.params;

  let shouldChain = false;
  let shouldTriggerQA = false;

  try {
    const result = await processOneJob(batchId);
    shouldChain = result.chain;
    shouldTriggerQA = result.triggerQA;
  } catch (err) {
    console.error('[process-next] Unhandled error in processOneJob:', err);
    shouldChain = true; // still try to chain to the next job
  }

  const baseUrl = getBaseUrl();
  let chainDispatched = false;
  let qaDispatched = false;

  // ── PRIMARY DISPATCH: Awaited fetch with retry ──
  // We await the fetch so we KNOW it was received. If both retries fail,
  // after() acts as a true backup.
  if (shouldTriggerQA) {
    qaDispatched = await reliableFetch(
      `${baseUrl}/api/batches/${batchId}/process-qa`,
      'QA trigger'
    );
  }
  if (shouldChain) {
    chainDispatched = await reliableFetch(
      `${baseUrl}/api/batches/${batchId}/process-next`,
      'chain-next'
    );
  }

  // ── BACKUP: after() fires if primary dispatch failed ──
  // Also fires as redundant safety even if primary succeeded — the chain
  // handlers are idempotent so duplicate invocations are harmless.
  if ((shouldChain && !chainDispatched) || (shouldTriggerQA && !qaDispatched)) {
    console.warn(
      `[process-next] Primary dispatch incomplete — chain: ${chainDispatched}, qa: ${qaDispatched}. ` +
      `Relying on after() backup for batch ${batchId}`
    );
  }

  if (shouldChain || shouldTriggerQA) {
    after(async () => {
      try {
        if (shouldTriggerQA && !qaDispatched) {
          await reliableFetch(
            `${baseUrl}/api/batches/${batchId}/process-qa`,
            'QA trigger (after backup)'
          );
        }
        if (shouldChain && !chainDispatched) {
          const backupOk = await reliableFetch(
            `${baseUrl}/api/batches/${batchId}/process-next`,
            'chain-next (after backup)'
          );
          if (!backupOk) {
            console.error(
              `[process-next] CRITICAL: Both primary and after() backup failed to chain batch ${batchId}. ` +
              `Health check must recover this batch.`
            );
          }
        }
      } catch (err) {
        console.error('[process-next] after() backup error:', err);
      }
    });
  }

  // Log when chain intentionally stops
  if (!shouldChain && !shouldTriggerQA) {
    console.log(`[process-next] Chain stopped for batch ${batchId} — no more work to dispatch`);
  }

  return NextResponse.json({ status: 'processing' });
}

/**
 * Optimistic-lock UPDATE on generation_jobs that only writes if THIS worker
 * still owns the claim. Race-condition fix (Sprint 5 Issue #0a): without the
 * status+claimed_by guard, a stale-recovery from /api/batches/[batchId]/health
 * (or another concurrent worker) can reset status='generating' → 'pending'
 * mid-flight, allowing a second claim_next_job to hand the same job to a
 * parallel worker. Both workers then race writes — the first to finish wins,
 * the second clobbers it. The .eq('status','generating') + .eq('claimed_by')
 * filter ensures only the still-owning worker writes.
 *
 * Returns true if the UPDATE matched (we still own the claim). Returns false
 * if another worker took over — caller should bail out and let that worker
 * complete the job.
 */
async function attemptOwnedUpdate(
  supabase: ReturnType<typeof createAdminClient>,
  jobId: string,
  workerId: string,
  updates: Record<string, unknown>,
  abortContext: string,
): Promise<boolean> {
  const fullUpdates = { ...updates, updated_at: new Date().toISOString() };
  const { data: updated } = await supabase
    .from('generation_jobs')
    .update(fullUpdates as never)
    .eq('id', jobId)
    .eq('status', 'generating')
    .eq('claimed_by', workerId)
    .select('id')
    .maybeSingle();
  if (!updated) {
    logPipelineEvent(jobId, 'STALE_CLAIM_ABORTED', abortContext);
    return false;
  }
  return true;
}

async function processOneJob(batchId: string): Promise<{ chain: boolean; triggerQA: boolean }> {
  const supabase = createAdminClient();

  // Get batch info
  const { data: batch, error: batchError } = await supabase
    .from('generation_batches')
    .select('*, project:projects(*)')
    .eq('id', batchId)
    .single();

  if (!batch) {
    console.log('[process-next] Batch not found:', batchId, batchError?.message);
    return { chain: false, triggerQA: false };
  }

  // Check if batch is halted — but still process never-attempted jobs
  if (batch.status === 'halted') {
    const { count: neverProcessed } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'pending')
      .eq('attempt', 0);

    if (!neverProcessed || neverProcessed === 0) {
      console.log('[process-next] Batch is halted and no unprocessed jobs, stopping chain:', batchId);
      return { chain: false, triggerQA: false };
    }
    // Un-halt: there are jobs that were never even attempted
    console.log(`[process-next] Batch halted but ${neverProcessed} jobs never processed — continuing`);
    await supabase
      .from('generation_batches')
      .update({ status: 'generating' })
      .eq('id', batchId);
  }

  // ── SELF-HEALING: Reset stale "generating" jobs (stuck > 90s) ──
  // If batch is halted (e.g. user-cancel), push stale jobs to `error` instead of `pending`
  // so they don't get reclaimed and re-unhalt the batch on the next invocation.
  // BRAND_ONLY jobs are owned by the regen route and must NOT be touched by the batch chain.
  const staleThreshold = new Date(Date.now() - 90_000).toISOString();
  const { data: rawStaleJobs } = await supabase
    .from('generation_jobs')
    .select('id, prompt_adjustment')
    .eq('batch_id', batchId)
    .eq('status', 'generating')
    .lt('updated_at', staleThreshold);
  const staleJobs = (rawStaleJobs || []).filter(
    (j) => j.prompt_adjustment !== 'BRAND_ONLY',
  );

  if (staleJobs?.length) {
    const batchIsHalted = batch.status === 'halted';
    const resetStatus = batchIsHalted ? 'error' : 'pending';
    const resetMsg = batchIsHalted
      ? 'Cancelado por usuario (stale generating)'
      : 'Auto-recovered: stale generating job reset by process-next';
    for (const stale of staleJobs) {
      await supabase
        .from('generation_jobs')
        .update({
          status: resetStatus,
          error_message: resetMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', stale.id);
    }
    console.log(`[process-next] Self-healed: reset ${staleJobs.length} stale generating jobs → ${resetStatus}`);
  }

  // ── SELF-HEALING: Trigger QA for stale qa_pending jobs (stuck > 90s) ──
  const { count: staleQaCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .eq('status', 'qa_pending')
    .lt('updated_at', staleThreshold);

  if (staleQaCount && staleQaCount > 0) {
    const baseUrlForQA = getBaseUrl();
    // Use awaited fetch for self-healing QA trigger too
    reliableFetch(
      `${baseUrlForQA}/api/batches/${batchId}/process-qa`,
      'self-heal QA trigger'
    ).catch(() => {});
    console.log(`[process-next] Self-healed: triggered QA chain for ${staleQaCount} stale qa_pending jobs`);
  }

  // ── ATOMIC CLAIM ──
  // Uses claim_next_job() RPC which wraps UPDATE...WHERE status='pending'
  // FOR UPDATE SKIP LOCKED in a single atomic statement. Two concurrent
  // invocations of process-next cannot claim the same job. Fixes the
  // re-pickup / parallel-pickup race that caused jobs to be processed 3-8
  // times in the historical data (135 jobs with 2+ PICKED_UP events).
  const workerId = `${process.env.VERCEL_REGION || 'local'}-${crypto.randomUUID().slice(0, 8)}`;
  const { data: claimedJobs, error: claimErr } = await supabase
    .rpc('claim_next_job', { p_batch_id: batchId, p_worker_id: workerId });

  if (claimErr) {
    console.error('[process-next] claim_next_job RPC failed:', claimErr.message);
    return { chain: false, triggerQA: false };
  }

  const claimedJob = Array.isArray(claimedJobs) && claimedJobs.length > 0 ? claimedJobs[0] : null;

  if (!claimedJob) {
    // No more pending jobs — generation chain complete (or claimed by another worker)
    console.log('[process-next] No pending jobs claimable for batch:', batchId);

    // Safety net: ensure QA chain is running for any remaining qa_pending or qa_processing
    const { count: qaNeededCount } = await supabase
      .from('generation_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['qa_pending', 'qa_processing']);

    if (qaNeededCount && qaNeededCount > 0) {
      console.log(`[process-next] Safety net: ${qaNeededCount} qa_pending/qa_processing — ensuring QA chain`);
      return { chain: false, triggerQA: true };
    } else {
      // Check if truly done (no generating, no qa_pending, no qa_processing, no pending)
      const { count: activeCount } = await supabase
        .from('generation_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batchId)
        .in('status', ['generating', 'qa_pending', 'qa_processing', 'pending']);

      if (!activeCount || activeCount === 0) {
        console.log('[process-next] All jobs done for batch:', batchId);
        await supabase
          .from('generation_batches')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', batchId);
      }
    }
    return { chain: false, triggerQA: false };
  }

  // Fetch hero_shot and swatch for the claimed job (the RPC returns the raw
  // job row without joins — two lookups are fine, they're both single-row by PK).
  const [{ data: heroShotData }, { data: swatchData }] = await Promise.all([
    claimedJob.hero_shot_id
      ? supabase.from('hero_shots').select('*').eq('id', claimedJob.hero_shot_id).single()
      : Promise.resolve({ data: null }),
    claimedJob.swatch_id
      ? supabase.from('swatches').select('*').eq('id', claimedJob.swatch_id).single()
      : Promise.resolve({ data: null }),
  ]);

  const job = { ...claimedJob, hero_shot: heroShotData, swatch: swatchData };
  const project = batch.project;
  const category = project?.category || 'textile';
  const strategy = getCategoryStrategy(category);
  const projectSettings = getProjectSettings(project?.metadata as Record<string, unknown> | null);
  const maxRetries = projectSettings.qa.max_retries;

  // ── ANTI-LOOP: if attempt >= max retries, check if already QA-approved before flagging ──
  if (job.attempt >= maxRetries) {
    // If the job already has a passing QA score (from a previous attempt that was
    // reset by stale recovery), approve it instead of flagging.
    const autoApproveThreshold = projectSettings.qa.auto_approve_threshold;
    const existingScore = job.qa_score ? parseFloat(job.qa_score) : 0;
    if (existingScore >= autoApproveThreshold) {
      console.log(
        `[process-next] Job ${job.id.substring(0, 8)} — attempt ${job.attempt} >= max ${maxRetries}, ` +
        `but QA score ${(existingScore * 100).toFixed(0)}% >= ${(autoApproveThreshold * 100).toFixed(0)}% — approving`
      );
      const owned = await attemptOwnedUpdate(supabase, job.id, workerId, {
        status: 'approved',
        error_message: null,
      }, 'antiloop-existing-score-approve');
      if (!owned) return { chain: true, triggerQA: false };

      await supabase
        .from('generation_batches')
        .update({
          completed_count: (batch.completed_count || 0) + 1,
          approved_count: (batch.approved_count || 0) + 1,
        })
        .eq('id', batchId);

      return { chain: true, triggerQA: false };
    }

    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — attempt ${job.attempt} >= max ${maxRetries}, flagging directly`
    );
    const ownedFlag = await attemptOwnedUpdate(supabase, job.id, workerId, {
      status: 'flagged',
      error_message: `Max QA retries (${maxRetries}) reached without approval`,
    }, 'antiloop-max-retries-flagged');
    if (!ownedFlag) return { chain: true, triggerQA: false };

    // Update batch counters
    await supabase
      .from('generation_batches')
      .update({
        completed_count: (batch.completed_count || 0) + 1,
        flagged_count: (batch.flagged_count || 0) + 1,
      })
      .eq('id', batchId);

    return { chain: true, triggerQA: false };
  }

  const isBrandOnly = job.prompt_adjustment === 'BRAND_ONLY';
  // User uploads and true ML imports both lack a hero_shot. Neither is regen-able
  // through the batch chain (the /results/[jobId] regen route is responsible
  // for user uploads and uses the uploaded image as hero). Treat both the same
  // here — defensive auto-approve so process-next never crashes trying to
  // download a missing hero_shot.storage_path.
  const isMLImport = !job.hero_shot || job.prompt_adjustment === 'ML_IMPORT';

  // BRAND_ONLY jobs are owned by the regen route (/api/projects/[id]/results/[jobId]),
  // not by the batch chain. If one lands here (cron reset after a slow Brand Gemini
  // call), DON'T touch it — the regen after() is likely still finishing, and auto-
  // approving would clobber its output. Unclaim and chain to the next job.
  if (isBrandOnly) {
    logPipelineEvent(job.id, 'BRAND_ONLY_SKIP', 'process-next released BRAND_ONLY job back to regen route', { batch_id: batchId });
    // Optimistic release: only clear claim if WE still own it. Otherwise the
    // regen route's after() may already be working on this job — clobbering
    // its claim_by would let a parallel worker pick it up mid-regen.
    await attemptOwnedUpdate(supabase, job.id, workerId, {
      status: 'generating',
      claimed_by: null,
      claimed_at: null,
    }, 'brand-only-release');
    return { chain: true, triggerQA: false };
  }

  // ML imports have no hero_shot — they shouldn't go through Gemini generation.
  // If one ends up here (e.g. delegated from regenerateJob after verification failed),
  // mark as approved using the existing output instead of crashing.
  if (isMLImport) {
    logPipelineEvent(job.id, 'ML_IMPORT_SKIP', 'process-next received ML import — auto-approving', { batch_id: batchId });
    await attemptOwnedUpdate(supabase, job.id, workerId, {
      status: 'approved',
      qa_score: 1.0,
      qa_feedback: 'Auto-approved (ML import)',
    }, 'ml-import-auto-approve');
    return { chain: true, triggerQA: false };
  }

  // ── COST CAP GUARD (Sprint 2 issue #3) ──
  // Before doing the expensive work, check whether running this attempt
  // would push the job's cumulative cost beyond the per-category cap.
  // Attempt 0 is exempt (every job gets at least one shot).
  //
  // Source of truth for prior costs is pipeline_log PROVIDER_USED entries.
  // The cost_usd_actual column overwrites on every attempt, so it can't
  // be summed.
  if (job.attempt > 0) {
    const { data: pipelineLogRow } = await supabase
      .from('generation_jobs')
      .select('pipeline_log')
      .eq('id', job.id)
      .single();
    const log = (pipelineLogRow?.pipeline_log as Array<{ event: string; data?: unknown }> | null) || null;
    const accumulatedUsd = sumJobCostFromPipelineLog(
      log as Array<{ event: string; data?: string | Record<string, unknown> | null }> | null,
    );
    // Project the next attempt's cost via the same routing the generator
    // will use. Done before the heavier preprocessing work so we don't
    // burn time we'll throw away.
    const swatchProfileForCap = (job.swatch?.fabric_profile as { opacity?: 'opaque' | 'translucent' | 'sheer'; pattern_type?: string; complexity?: string } | null) || null;
    const nextModelId = selectModelId({
      category,
      swatchProfile: swatchProfileForCap,
      attempt: job.attempt,
    });
    const projectedNextUsd = MODEL_REGISTRY[nextModelId]?.costPerImageUsd ?? 0;
    const capUsd = getCostCapForCategory(category);
    const decision = evaluateCostCap({
      attempt: job.attempt,
      accumulatedUsd,
      projectedNextUsd,
      capUsd,
    });
    if (decision.exceeded) {
      // Flag (NOT error) — flagged jobs stay reviewable in the UI; error
      // hides them as technical failures. Cost cap is a deliberate
      // decision, not a fault.
      const existingMeta = (job.prompt_metadata as Record<string, unknown> | null) || {};
      logPipelineEvent(job.id, 'COST_CAP_EXCEEDED', 'flagged', {
        accumulated_usd: accumulatedUsd,
        projected_usd: decision.projectedUsd,
        cap_usd: capUsd,
        category,
        next_model_id: nextModelId,
      });
      const ownedCap = await attemptOwnedUpdate(supabase, job.id, workerId, {
        status: 'flagged',
        error_message: `Cost cap reached: $${decision.projectedUsd.toFixed(3)} projected vs $${capUsd.toFixed(2)} cap (${category}). Stopped before attempt ${job.attempt}.`,
        prompt_metadata: { ...existingMeta, cost_capped: true, cost_cap_decision: { accumulated_usd: accumulatedUsd, projected_usd: decision.projectedUsd, cap_usd: capUsd, attempt: job.attempt } },
      }, 'cost-cap-flagged');
      if (!ownedCap) return { chain: true, triggerQA: false };
      await supabase
        .from('generation_batches')
        .update({
          completed_count: (batch.completed_count || 0) + 1,
          flagged_count: (batch.flagged_count || 0) + 1,
        })
        .eq('id', batchId);
      console.log(
        `[process-next] Cost cap reached for job ${job.id.substring(0, 8)} ` +
        `(${category}, attempt ${job.attempt}): $${decision.projectedUsd.toFixed(3)} > $${capUsd.toFixed(2)} — flagged`,
      );
      return { chain: true, triggerQA: false };
    }
  }

  logPipelineEvent(job.id, 'PICKED_UP', 'process-next chain', { batch_id: batchId, attempt: job.attempt, brand_only: isBrandOnly });

  try {
    // Download hero and swatch
    const [heroRes, swatchRes] = await Promise.all([
      supabase.storage.from('images').download(job.hero_shot.storage_path),
      supabase.storage.from('images').download(job.swatch.storage_path),
    ]);

    if (heroRes.error || swatchRes.error) {
      throw new Error(`Storage download failed: ${heroRes.error?.message || swatchRes.error?.message}`);
    }

    const heroBuffer = Buffer.from(await heroRes.data.arrayBuffer());
    let swatchBuffer: Buffer = Buffer.from(await swatchRes.data.arrayBuffer());
    const originalSwatchBuffer = Buffer.from(swatchBuffer); // copy before collage may modify it
    let heroBase64 = heroBuffer.toString('base64');

    // Check for additional swatch reference images
    const { data: extraImages } = await supabase
      .from('swatch_images')
      .select('storage_path')
      .eq('swatch_id', job.swatch.id)
      .order('display_order');

    let swatchImageCount = 1;
    if (extraImages && extraImages.length > 0) {
      // Download all extra images and create collage
      const allBuffers = [swatchBuffer];
      for (const img of extraImages) {
        const { data: imgData } = await supabase.storage.from('images').download(img.storage_path);
        if (imgData) {
          allBuffers.push(Buffer.from(await imgData.arrayBuffer()));
        }
      }
      if (allBuffers.length > 1) {
        swatchBuffer = await createSwatchCollage(allBuffers);
        swatchImageCount = allBuffers.length;
        console.log(`[process-next] Created swatch collage with ${allBuffers.length} images`);
      }
    }

    let swatchBase64 = swatchBuffer.toString('base64');

    // ── BRAND_ONLY: source must be the existing job output, NOT the original hero ──
    // The brand pass only re-paints text colors/fonts and adds the logo. It must not
    // regenerate the product. Mirrors regenerateJob (results/[jobId]/route.ts) so that
    // when the brand button times out and falls through to process-next, we preserve
    // the previous variant instead of overwriting it with the hero (which would lose
    // the swatch color applied in the original generation).
    if (isBrandOnly) {
      const projectId = job.swatch?.project_id as string | undefined;
      let brandSourceBuffer: Buffer | null = null;
      if (projectId) {
        const preBrandPath = `projects/${projectId}/generated/${job.id}_pre_brand.png`;
        const { data: preBrandData } = await supabase.storage.from('images').download(preBrandPath);
        if (preBrandData) {
          brandSourceBuffer = Buffer.from(await preBrandData.arrayBuffer());
          logPipelineEvent(job.id, 'BRAND_SOURCE', 'pre_brand backup', { path: preBrandPath });
        } else if (job.output_storage_path) {
          const { data: outData } = await supabase.storage.from('images').download(job.output_storage_path);
          if (outData) {
            brandSourceBuffer = Buffer.from(await outData.arrayBuffer());
            await supabase.storage.from('images').upload(preBrandPath, brandSourceBuffer, {
              contentType: 'image/png', upsert: true,
            });
            logPipelineEvent(job.id, 'BRAND_SOURCE', 'previous output (backup saved)', { path: job.output_storage_path });
          }
        }
      }
      if (brandSourceBuffer) {
        heroBase64 = brandSourceBuffer.toString('base64');
        swatchBuffer = brandSourceBuffer;
        swatchBase64 = brandSourceBuffer.toString('base64');
      } else {
        logPipelineEvent(job.id, 'BRAND_SOURCE', 'fallback to original hero (no previous output found)');
      }
    }

    // Detect dark swatches for prompt adjustments (use original swatch, not collage)
    const darkSwatch = await isSwatchDark(originalSwatchBuffer);
    if (darkSwatch) {
      console.log(`[process-next] Dark swatch: "${job.swatch.name}"`);
    }

    // ── Auto-analyze swatch color if missing (skip for BRAND_ONLY — not changing product) ──
    // Uses Gemini Flash (~2s) to detect color, then caches in DB for future jobs
    // Use short color description only (not planner's long analysis)
    const rawColorDesc = job.swatch.color_description;
    let swatchColorDescription = (rawColorDesc && rawColorDesc.length <= 100) ? rawColorDesc : null;
    // Fallback: always have at least the swatch name as color reference
    if (!swatchColorDescription) swatchColorDescription = job.swatch.name;
    if (!rawColorDesc && !isBrandOnly) {
      console.log(`[process-next] Swatch "${job.swatch.name}" has no color_description — auto-analyzing...`);
      try {
        const colorAnalysis = await analyzeSwatchColor(
          swatchBuffer.toString('base64'),
          job.swatch.mime_type || 'image/png'
        );
        if (colorAnalysis) {
          swatchColorDescription = colorAnalysis.colorDescription;
          console.log(`[process-next] Auto-detected color: "${swatchColorDescription}" (${colorAnalysis.dominantHex})`);
          // Cache in DB (non-blocking — don't let failure stop generation)
          Promise.resolve(
            supabase
              .from('swatches')
              .update({
                color_description: colorAnalysis.colorDescription,
                dominant_color_hex: colorAnalysis.dominantHex,
              })
              .eq('id', job.swatch.id)
          ).catch((err: unknown) => console.error('[process-next] Failed to cache swatch color:', err));
        }
      } catch (err) {
        console.error('[process-next] Swatch color analysis failed (non-blocking):', err);
      }
    }

    // ── Get QA feedback from previous attempt (for retries) ──
    // GUARD: if the verifier PASSED on the previous attempt but QA flagged it,
    // the QA feedback is likely a false negative (verifier is more reliable for
    // fabric fidelity). Injecting wrong feedback poisons the retry — Gemini
    // becomes confused and produces partial pattern coverage (e.g. pillowcases
    // half-white). Only use QA feedback when the verifier also failed or was
    // not run.
    const prevVerifierPassed = (job.prompt_metadata as Record<string, unknown>)?.verification_pass === true;
    const rawQaFeedback = job.attempt > 0 ? (job.qa_feedback || null) : null;
    const qaFeedback = (rawQaFeedback && !prevVerifierPassed) ? rawQaFeedback : null;
    if (rawQaFeedback && prevVerifierPassed) {
      console.log(`[process-next] Discarding QA feedback (verifier passed — QA likely false negative): "${rawQaFeedback}"`);
    } else if (qaFeedback) {
      console.log(`[process-next] Retry with QA feedback: "${qaFeedback}"`);
    }

    // ── Auto-detect shot type — use cache from hero_shots if available ──
    let effectiveShotType = job.hero_shot.detected_shot_type || job.hero_shot.shot_type || 'lifestyle';
    let shotTypeDetectionMeta: { confidence?: number; description?: string; overridden?: boolean } | null = null;
    if (isBrandOnly) {
      console.log(`[process-next] BRAND_ONLY — using shot type: ${effectiveShotType}`);
    } else if (!job.hero_shot.detected_shot_type) {
      try {
        const detection = await detectShotType(heroBase64, job.hero_shot.mime_type || 'image/png');
        if (detection) {
          shotTypeDetectionMeta = {
            confidence: detection.confidence,
            description: detection.description,
            overridden: false,
          };
          if (detection.confidence >= 0.7 && detection.detected_type !== effectiveShotType) {
            console.log(
              `[process-next] Shot type override: "${effectiveShotType}" → "${detection.detected_type}" ` +
              `(confidence: ${(detection.confidence * 100).toFixed(0)}%, desc: "${detection.description}")`
            );
            effectiveShotType = detection.detected_type;
            shotTypeDetectionMeta.overridden = true;
          }
        }
        // Cache in hero_shots (non-blocking)
        supabase.from('hero_shots').update({ detected_shot_type: effectiveShotType }).eq('id', job.hero_shot.id).then(() => {});
      } catch (err) {
        console.error('[process-next] Shot type detection failed (non-blocking):', err);
      }
    } else {
      console.log(`[process-next] Using cached shot type: ${effectiveShotType}`);
    }

    logPipelineEvent(job.id, 'SHOT_TYPE', effectiveShotType, {
      cached: !!job.hero_shot.detected_shot_type,
      ...(shotTypeDetectionMeta || {}),
    });

    // Infografia flows through the normal Gemini edit path — same rule as every
    // other shot type: hero literal, only the fabric changes to the swatch's.
    // The previous Sharp-only shortcut existed because Gemini was corrupting
    // text, but that was really flatten_hero destroying text before Gemini
    // saw it (same root cause as the face-regeneration bug for lifestyle).
    // With flatten_hero disabled by default in the quilts strategy, Gemini
    // preserves text pixel-perfect.

    // ── Determine effective generation mode ──
    let effectiveMode = projectSettings.generation.mode !== 'auto'
      ? projectSettings.generation.mode
      : getEffectiveMode(strategy, job.attempt);

    // Pattern comparison decides the correct mode:
    //   - patterns SIMILAR    → downgrade reference → edit (color change only)
    //   - patterns DIFFERENT  → stay in the strategy default (edit for quilts).
    //     The previous logic pre-emptively escalated quilts to reference/from_scratch
    //     on pattern mismatch, but that caused reference mode to invent accent props
    //     (pillows, throws) that didn't exist in the hero — e.g. job e00c5c59 got a
    //     decorative white pillow that was not in the hero or the swatch. Flat textures
    //     (waffle / piqué / channel) are fine in edit mode; only deep 3D embossed
    //     quilting (mandala, basket weave) genuinely fails, and that case is handled
    //     by the hero_contamination escalation in the QA retry path.
    //   - not run for BRAND_ONLY (we're not changing the product).
    let patternSimilarity: boolean | null = null;
    let patternAutoSwitchReason: string | null = null;
    if (!isBrandOnly && job.hero_shot) {
      // Cache layer 1: previous attempt of THIS job already computed it.
      // Inputs (hero+swatch images) are immutable across retries → safe to reuse.
      const prevMeta = job.prompt_metadata as Record<string, unknown> | null;
      const prevSim = prevMeta?.pattern_similarity;
      // Cache layer 2: hero_shots.pattern_similarity_cache keyed by swatch_id.
      // Persists across jobs and across batches for the same (hero, swatch) pair.
      const heroCache = ((job.hero_shot as Record<string, unknown>).pattern_similarity_cache
        ?? {}) as Record<string, boolean>;
      const heroCacheHit = job.swatch.id && typeof heroCache[job.swatch.id] === 'boolean'
        ? heroCache[job.swatch.id]
        : null;

      let cacheSource: 'job_retry' | 'hero_cache' | null = null;
      if (job.attempt > 0 && (prevSim === true || prevSim === false)) {
        patternSimilarity = prevSim as boolean;
        cacheSource = 'job_retry';
      } else if (heroCacheHit !== null) {
        patternSimilarity = heroCacheHit;
        cacheSource = 'hero_cache';
      } else {
        try {
          patternSimilarity = await arePatternsSimlar(
            heroBase64, job.hero_shot.mime_type || 'image/png',
            swatchBase64, 'image/png',
          );
          // Persist in hero_shots cache (non-blocking).
          if (job.hero_shot.id && job.swatch.id && patternSimilarity !== null) {
            const next = { ...heroCache, [job.swatch.id]: patternSimilarity };
            supabase.from('hero_shots')
              .update({ pattern_similarity_cache: next })
              .eq('id', job.hero_shot.id)
              .then(() => {}, () => {});
          }
        } catch (err) {
          console.error('[process-next] Pattern comparison failed (using default):', err);
        }
      }

      if (patternSimilarity === true && effectiveMode === 'reference') {
        effectiveMode = 'edit';
        patternAutoSwitchReason = 'patterns_similar_reference_to_edit';
        console.log(`[process-next] Patterns similar → switching to edit (color change only)`);
      }
      logPipelineEvent(job.id, 'PATTERN_COMPARED', String(patternSimilarity), {
        auto_switch: patternAutoSwitchReason,
        effective_mode: effectiveMode,
        cache_source: cacheSource,
      });
    }

    // Detail/doblada shots use edit mode to preserve composition.
    // Infografia: only force edit if category default is edit (quilts need reference for pattern change).
    const forceEdit = effectiveShotType === 'detail' || effectiveShotType === 'doblada'
      || (effectiveShotType === 'infografia' && strategy.generation_mode === 'edit');
    if (forceEdit && effectiveMode !== 'edit') {
      console.log(`[process-next] Forcing edit mode for ${effectiveShotType} shot (was ${effectiveMode})`);
      effectiveMode = 'edit';
    }

    const baseTemperature = getEffectiveTemperature(strategy, effectiveMode, job.attempt);
    const temperature = projectSettings.generation.temperature !== 0.2
      ? projectSettings.generation.temperature
      : baseTemperature;

    logPipelineEvent(job.id, 'MODE_SELECTED', effectiveMode, { temperature, force_edit: forceEdit });

    console.log(
      `[process-next] Job ${job.id.substring(0, 8)} — ` +
      `category: ${category}, mode: ${effectiveMode}, shotType: ${effectiveShotType}, attempt: ${job.attempt}, temp: ${temperature}` +
      `${swatchColorDescription ? `, color: ${swatchColorDescription}` : ''}`
    );

    // ── Preprocessing (skip for BRAND_ONLY — we want the image unchanged) ──
    // Save original swatch before crop (flattener needs the full image, not cropped)
    const originalSwatchBase64 = swatchBase64;

    // ── Swatch Pattern Analysis (Planner) — runs EARLY so the rotation gate below
    // can see the real pattern description, not just the cached short color label
    // ("Crema") which always fails hasDirectionalPattern() and silently disables
    // the auto-rotation path.
    let swatchPatternDescription: string | null = null;
    let swatchPatternSource: 'job_retry' | 'swatch_cache' | 'computed' | 'none' = 'none';
    if (!isBrandOnly) {
      // Cache layer 1: previous attempt of THIS job already wrote it.
      const prevJobPattern = job.swatch_pattern_text as string | null;
      // Cache layer 2: per-swatch description (populated by upload pre-warm or
      // a previous job using this swatch).
      const swatchCached = job.swatch.color_description;

      if (job.attempt > 0 && prevJobPattern && prevJobPattern.length > 100) {
        swatchPatternDescription = prevJobPattern;
        swatchPatternSource = 'job_retry';
      } else if (swatchCached && swatchCached.length > 100) {
        swatchPatternDescription = swatchCached;
        swatchPatternSource = 'swatch_cache';
        console.log(`[process-next] Using cached swatch pattern analysis for ${job.swatch.name}`);
      } else {
        swatchPatternDescription = await analyzeSwatchPattern(
          swatchBase64,
          'image/png',
          job.swatch.name,
        );
        if (swatchPatternDescription) {
          swatchPatternSource = 'computed';
          const existing = job.swatch.color_description;
          if (!existing || existing.length > 100) {
            supabase.from('swatches')
              .update({ color_description: swatchPatternDescription })
              .eq('id', job.swatch.id)
              .then(() => {});
          }
        }
      }
    }
    logPipelineEvent(job.id, 'PATTERN_ANALYSIS', swatchPatternDescription ? 'available' : 'none', {
      cache_source: swatchPatternSource,
      length: swatchPatternDescription?.length || 0,
    });

    // Auto-rotation: ask Gemini directly "would horizontal stripes appear
    // left-right or top-bottom on this bed?". top_bottom → rotate 90°.
    // See results/[jobId]/route.ts and src/lib/bed-camera-angle.ts.
    let autoRotateSwatch = 0;
    const ROTATION_PRONE = ['quilts', 'cubrecamas', 'plumones', 'sabanas'];
    const jobPatternText = swatchPatternDescription
      || (job.swatch_pattern_text as string | null)
      || job.swatch.color_description;
    if (
      !isBrandOnly &&
      ROTATION_PRONE.includes(category) &&
      hasDirectionalPattern(jobPatternText) &&
      job.hero_shot
    ) {
      let cachedAxis = (job.hero_shot as Record<string, unknown>).bed_camera_angle as StripeVisualAxis | null | undefined;
      if (cachedAxis !== 'left_right' && cachedAxis !== 'top_bottom') cachedAxis = null;
      if (!cachedAxis) {
        try {
          cachedAxis = await detectStripeVisualAxis(heroBase64, job.hero_shot.mime_type || 'image/png');
          if (cachedAxis && job.hero_shot.id) {
            supabase.from('hero_shots').update({ bed_camera_angle: cachedAxis }).eq('id', job.hero_shot.id).then(() => {});
          }
        } catch (err) {
          console.error('[process-next] Stripe axis detection failed:', err);
        }
      }
      if (cachedAxis === 'top_bottom') {
        autoRotateSwatch = 90;
        logPipelineEvent(job.id, 'AUTO_ROTATE_SWATCH', '90deg', { reason: 'stripes_top_bottom' });
        console.log(`[process-next] Auto-rotating swatch 90° (stripes appear top-bottom in camera)`);
      } else if (cachedAxis) {
        logPipelineEvent(job.id, 'STRIPE_AXIS_CHECKED', cachedAxis, { rotated: false });
      }
    }

    if (!isBrandOnly) {
      if (strategy.preprocessing.flatten_hero) {
        const flattenedHero = await flattenHeroEmboss(heroBuffer);
        heroBase64 = flattenedHero.toString('base64');
        console.log(`[process-next] Flattened hero emboss for ${category}`);
      }
      if (strategy.preprocessing.crop_swatch) {
        // Detail shots: skip the 2x2 tile. Tiling exists to give pillowcases
        // enough motif density on lifestyle bed shots, but for close-up detail
        // shots there are no pillowcases AND the tiling multiplies any shadow
        // gradient at the bottom of the crop into 4 fake "fold edges" that
        // Gemini then copies onto the hero — verified on job 24e9e5c5.
        const useTile = strategy.preprocessing.tile_swatch && effectiveShotType !== 'detail';
        const cropFn = useTile ? cropAndTileSwatchToFabric : cropSwatchToFabric;
        let croppedSwatch = await cropFn(swatchBuffer);
        if (autoRotateSwatch) {
          const sharpRot = (await import('sharp')).default;
          croppedSwatch = await sharpRot(croppedSwatch).rotate(autoRotateSwatch).png().toBuffer();
          logPipelineEvent(job.id, 'SWATCH_ROTATED', `${autoRotateSwatch}deg`);
        }
        swatchBase64 = croppedSwatch.toString('base64');
      }
    }

    logPipelineEvent(job.id, 'PREPROCESS', isBrandOnly ? 'skip' : 'done', {
      crop_swatch: strategy.preprocessing.crop_swatch,
      flatten_hero: strategy.preprocessing.flatten_hero,
      flatten_swatch_ai: strategy.preprocessing.flatten_swatch_ai || false,
    });

    // Save cropped (pre-flatten) swatch for verification — the AI flattener can
    // misinterpret textures (e.g. waffle weave → diamond), so the verifier must
    // compare against the REAL swatch pattern, not the AI-generated flat version.
    const swatchBase64ForVerification = swatchBase64;

    // AI-based swatch flattening — generates flat pattern view for detailed textiles
    // Uses ORIGINAL swatch (not cropped) to preserve correct texture at natural scale
    // SKIP on retries: if the verifier already rejected this job, the AI flattener may
    // have introduced a wrong pattern. Use the real cropped swatch on retries instead.
    const skipFlattenOnRetry = qaFeedback != null;
    if (strategy.preprocessing.flatten_swatch_ai && !isBrandOnly && !skipFlattenOnRetry) {
      // Check cache first: look for flat version in swatch_images
      const { data: flatCache } = await supabase
        .from('swatch_images')
        .select('storage_path')
        .eq('swatch_id', job.swatch.id)
        .eq('label', 'flat')
        .limit(1)
        .single();

      if (flatCache?.storage_path) {
        // Use cached flat swatch
        const { data: flatData } = await supabase.storage.from('images').download(flatCache.storage_path);
        if (flatData) {
          const flatBuffer = Buffer.from(await flatData.arrayBuffer());
          swatchBase64 = flatBuffer.toString('base64');
          console.log(`[process-next] Using cached flat swatch for ${job.swatch.name}`);
        }
      } else {
        // Generate flat swatch with AI
        console.log(`[process-next] Generating flat swatch for ${job.swatch.name}...`);
        const flatBuffer = await flattenSwatchWithAI(
          originalSwatchBase64,
          'image/png',
          job.swatch.color_description || undefined
        );
        if (flatBuffer) {
          swatchBase64 = flatBuffer.toString('base64');
          // Cache for future jobs (non-blocking)
          const flatPath = `projects/${job.swatch.project_id}/swatches/${job.swatch.id}_flat.png`;
          supabase.storage.from('images').upload(flatPath, flatBuffer, { contentType: 'image/png', upsert: true }).then(({ error }) => {
            if (!error) {
              supabase.from('swatch_images').insert({
                id: crypto.randomUUID(),
                swatch_id: job.swatch.id,
                storage_path: flatPath,
                label: 'flat',
                file_size_kb: Math.round(flatBuffer.length / 1024),
                display_order: 99,
              }).then(() => {});
            }
          });
          console.log(`[process-next] Flat swatch generated and cached for ${job.swatch.name}`);
        } else {
          console.log(`[process-next] Flat swatch generation failed, using cropped swatch`);
        }
      }
    }

    if (skipFlattenOnRetry && strategy.preprocessing.flatten_swatch_ai) {
      console.log(`[process-next] Skipping AI flatten on retry — using cropped swatch for ${job.swatch.name}`);
    }

    // ── Build prompt ──
    const swatchHex = job.swatch.dominant_color_hex || null;
    let prompt: string;

    if (isBrandOnly) {
      // BRAND_ONLY mode: reproduce image with brand applied
      // Brand is loaded below — we build logo clearance instructions after loading it
      prompt = `Reproduce Image 1 preserving the product, scene, composition, background, and lighting. Do NOT change the product itself.

Image 2 is the SAME image as reference — do NOT use it to change colors or patterns.

IMPORTANT — You MUST apply the brand changes specified below:
- CHANGE all visible text colors to match the brand palette below
- CHANGE all visible text typography/fonts to match the brand fonts below
- Keep the same text content, only change COLOR and FONT
These changes are MANDATORY, not optional.

Everything else (product, background, people, objects) must remain as in Image 1.

Output: ${projectSettings.generation.resolution}px, RGB, PNG.`;
      console.log(`[process-next] BRAND_ONLY mode — reproducing image with brand guidelines`);
    } else {
      // Hero overlays (text/branding/dimensions) need to be preserved by the
      // edit prompt. Run the analyzer here (independent of brand) so projects
      // without a brand still get overlay preservation. Cached in
      // hero_shots.text_elements after first run.
      let detectedHeroOverlays = job.hero_shot?.text_elements as
        | Array<{ text: string; position?: string; size?: string; role?: string }>
        | null
        | undefined;
      if ((!detectedHeroOverlays || (Array.isArray(detectedHeroOverlays) && detectedHeroOverlays.length === 0)) && job.hero_shot?.id) {
        try {
          const textAnalysis = await analyzeTextElements(heroBase64, job.hero_shot.mime_type || 'image/png');
          if (textAnalysis?.elements?.length) {
            detectedHeroOverlays = textAnalysis.elements;
            // Mutate in-memory so the OVERLAY_RESTORED composite gate below
            // (which reads job.hero_shot.text_elements) sees the fresh data
            // on the same request, not just on subsequent jobs.
            (job.hero_shot as Record<string, unknown>).text_elements = detectedHeroOverlays;
            supabase.from('hero_shots').update({ text_elements: detectedHeroOverlays }).eq('id', job.hero_shot.id).then(() => {}, () => {});
            logPipelineEvent(job.id, 'HERO_OVERLAYS_DETECTED', `${detectedHeroOverlays.length} elements`);
          }
        } catch (err) {
          console.error('[process-next] analyzeTextElements failed (non-blocking):', err);
        }
      }
      prompt = buildPromptForMode(
        effectiveMode,
        strategy,
        job.swatch.name,
        swatchColorDescription,
        effectiveShotType,
        darkSwatch,
        qaFeedback,
        projectSettings.generation.resolution,
        swatchHex,
        patternSimilarity === false,
        detectedHeroOverlays ?? null,
      );
    }

    // Directional hint — SKIPPED for ROTATION_PRONE categories because those
    // go through the classifier+rotation path (authoritative). The analyzer
    // mislabels bed-scene swatches (e.g. horizontal stripes called "vertical"
    // because the side drape wraps), and the hint would push Gemini wrong.
    const ROT_CATS = new Set(['quilts', 'cubrecamas', 'plumones', 'sabanas']);
    if (swatchPatternDescription && !isBrandOnly && !ROT_CATS.has(category)) {
      const lower = swatchPatternDescription.toLowerCase();
      let directionHint: string | null = null;
      if (/\bhorizontal(ly)?\b/.test(lower) && !/\bvertical/.test(lower)) {
        directionHint = 'HORIZONTAL (parallel to the bed\'s foot, running left-right across the width)';
      } else if (/\bvertical(ly)?\b/.test(lower) && !/\bhorizontal/.test(lower)) {
        directionHint = 'VERTICAL (running top-to-bottom, perpendicular to the bed\'s foot)';
      } else if (/\bdiagonal(ly)?\b/.test(lower) || /\bchevron\b/.test(lower)) {
        directionHint = 'DIAGONAL (running at an angle, as shown in the swatch)';
      }
      if (directionHint) {
        prompt += `\n\nORIENTATION HINT (pre-analyzed from swatch): The fabric pattern in Imagen 2 runs ${directionHint}. The result MUST reproduce the pattern in that exact direction.`;
        logPipelineEvent(job.id, 'DIRECTION_HINT', directionHint.split(' ')[0]);
      }
    }

    // Add brand guidelines to prompt if project has a brand (unless SKIP_BRAND flag)
    const skipBrand = job.prompt_adjustment === 'SKIP_BRAND';
    let brand: BrandConfig | null = null;
    let textElements: import('@/lib/brand').TextElement[] | null = null;
    const projectBrandId = project?.brand_id;
    if (projectBrandId && !skipBrand) {
      console.log(`[process-next] Project has brand_id: ${projectBrandId}`);
      const { data: brandData } = await supabase
        .from('brands')
        .select('*')
        .eq('id', projectBrandId)
        .single();
      if (brandData) {
        brand = brandData as BrandConfig;

        // Reuse hero overlays detected/cached above (independent of brand).
        const cachedElements = job.hero_shot.text_elements;
        if (cachedElements && Array.isArray(cachedElements) && cachedElements.length > 0) {
          textElements = cachedElements as import('@/lib/brand').TextElement[];
        }

        // Inject brand prompt: 'full' for BRAND_ONLY (includes logo prohibition), 'light' for normal (colors + typography only)
        const brandMode = isBrandOnly ? 'full' : 'light';
        const brandSection = buildBrandPromptSection(brand, effectiveShotType, textElements, brandMode);

        // If text overlaps logo zone, prepend shift instruction (BRAND_ONLY only)
        if (isBrandOnly) {
          const hasTopText = textElements?.some(el => el.position === 'top');
          const logoAtTop = brand.logo_position === 'top-left' || brand.logo_position === 'top-right';
          if (hasTopText && logoAtTop) {
            const clearSpace = brand.logo_size_px + brand.logo_margin_px + 10;
            const side = brand.logo_position === 'top-left' ? 'left' : 'right';
            const topTexts = textElements!.filter(el => el.position === 'top').map(el => `"${el.text}"`).join(', ');
            prompt = `FIRST PRIORITY: A ${brand.logo_size_px}px logo goes at top-${side}. Move ALL text in the top ${clearSpace}px down below that line. Texts to move: ${topTexts}. Do NOT add white boxes or backgrounds — keep the natural image background. Do NOT invent new text.\n\n${prompt}`;
            console.log(`[process-next] Prepended shift instruction for top texts`);
          }
        }

        prompt += brandSection;
        console.log(`[process-next] Brand loaded: ${brand.name}`);
      } else {
        console.log(`[process-next] Brand ${projectBrandId} not found in DB`);
      }
    } else {
      console.log(`[process-next] No brand_id on project`);
    }

    // Add size-aware note for 1P/1.5P bed products (skip for BRAND_ONLY — don't modify product)
    if (!isBrandOnly) {
      const sizeNote = buildSizePromptNote(job.swatch.sku_suffix, category, effectiveShotType);
      if (sizeNote) {
        prompt += sizeNote;
        console.log(`[process-next] Size adjustment added for SKU ${job.swatch.sku_suffix} (${category}, ${effectiveShotType})`);
      }
    }

    // Add collage note if swatch has multiple reference images
    if (swatchImageCount > 1) {
      prompt += `\n\nNOTA IMPORTANTE SOBRE IMAGEN 2: La Imagen 2 es un COLLAGE con ${swatchImageCount} fotos de referencia del mismo producto. Muestra diferentes angulos, texturas y detalles del producto. Usa TODAS las fotos del collage para entender el color, patron, textura y detalles exactos del producto. El resultado debe ser fiel a lo que muestran estas referencias combinadas.`;
    }

    const promptMetadata: Record<string, unknown> = {
      strategy: `${effectiveMode}`,
      category,
      attempt: job.attempt,
      temperature,
      dark_swatch: darkSwatch,
      crop_swatch: strategy.preprocessing.crop_swatch,
      flatten_hero: strategy.preprocessing.flatten_hero,
      flatten_swatch_ai: strategy.preprocessing.flatten_swatch_ai || false,
      swatch_color: swatchColorDescription || null,
      swatch_hex: swatchHex,
      qa_feedback_used: qaFeedback ? true : false,
      swatch_image_count: swatchImageCount,
      text_elements_detected: textElements || null,
      brand_name: brand?.name || null,
      brand_colors: brand ? {
        primary: brand.primary_color,
        secondary: brand.secondary_color,
        accent: brand.accent_color,
      } : null,
      logo_overlay_expected: brand?.apply_logo_overlay || false,
      swatch_pattern_analyzed: !!swatchPatternDescription,
      // ─── Observability v1 (commit 1 — data capture) ───
      pattern_similarity: patternSimilarity,          // null | true | false
      pattern_auto_switch_reason: patternAutoSwitchReason, // null | reason string
      shot_type_detection: shotTypeDetectionMeta,     // {confidence, description, overridden}
      force_edit: forceEdit,
      force_edit_reason: forceEdit
        ? (effectiveShotType === 'detail' || effectiveShotType === 'doblada'
            ? effectiveShotType
            : 'infografia_edit_default')
        : null,
      worker_id: workerId,
    };

    // Sprint 2 issue #2 — case_signature for telemetry grouping. Built at
    // the runtime point where every input is finalized (mode chosen, dark
    // detected, patterns compared). Sprint-1 telemetry source.
    const swatchProfileForSig = (job.swatch.fabric_profile as { opacity?: 'opaque' | 'translucent' | 'sheer' } | null) || null;
    const caseSignature = buildCaseSignature({
      category,
      shotType: effectiveShotType,
      patternsDiffer: patternSimilarity === null ? null : !patternSimilarity,
      isDarkSwatch: darkSwatch,
      opacity: swatchProfileForSig?.opacity || null,
    });
    promptMetadata._telemetry_source = 'sprint_1_runtime';

    // Persist prompt + attempt increment. Status was already set to 'generating'
    // atomically by claim_next_job() at the top of this function.
    const ownedPrompt = await attemptOwnedUpdate(supabase, job.id, workerId, {
      prompt_text: prompt,
      attempt: job.attempt + 1,
      prompt_metadata: promptMetadata,
      case_signature: caseSignature,
    }, 'prompt-persist-pre-generation');
    if (!ownedPrompt) return { chain: true, triggerQA: false };

    // ── Generate image based on mode ──
    // Escalate to Pro model for retries. Categories with fine/smooth weave
    // (quilts with waffle/pique; cortinas with lino/sarga) escalate after
    // just 1 failed attempt because Flash consistently produces coarser
    // weave than the reference, triggering verifier rejects. Other categories
    // retry with Flash once before escalating.
    const proThreshold = (category === 'quilts' || category === 'cortinas' || category === 'alfombras') ? 1 : 2;
    const useProModel = job.attempt >= proThreshold;

    logPipelineEvent(job.id, 'GENERATION_START', useProModel ? 'Pro' : 'Flash', {
      temperature, mode: effectiveMode, brand: brand?.name || null,
    });
    let result: GeminiGenerateResult | undefined;
    // Telemetry captured per generation path; persisted on the job at the end of this block.
    let providerUsed: string | undefined;
    let modelIdUsed: string | undefined;
    let costUsdActual: number | undefined;

    // ── Multi-pass generation for sabanas (DISABLED — single-pass Pro gives better results) ──
    if (false && category === 'sabanas' && effectiveMode === 'edit') {
      console.log(`[process-next] Using multi-pass generation for sabanas`);
      const multiResult = await generateSabanasMultiPass(
        heroBase64,
        job.hero_shot.mime_type || 'image/png',
        swatchBase64,
        'image/png',
        swatchBuffer,
        temperature,
        useProModel,
      );
      if (multiResult.success && multiResult.imageBuffer) {
        // Skip normal generation — use multi-pass result
        result = {
          success: true,
          imageBase64: multiResult.imageBuffer!.toString('base64'),
          imageMimeType: 'image/png',
          durationMs: 0,
        };
        promptMetadata.multipass = true;
        promptMetadata.multipass_passes = multiResult.passes;
        console.log(`[process-next] Multi-pass complete: ${multiResult.passes} passes`);
      } else {
        console.log(`[process-next] Multi-pass failed (${multiResult.error}), falling back to single-pass`);
        // Fall through to normal generation below
      }
    }

    // ── Normal single-pass generation (or fallback from multi-pass) ──
    // generateImageSmart routes entre Gemini Flash/Pro y GPT Image 2 según
    // category + swatch profile + attempt. Con ENABLE_GPT_IMAGE_2=0 (default)
    // siempre usa Gemini (comportamiento legacy, safe).
    if (!result) {
      const swatchProfile = (job.swatch.fabric_profile as Record<string, unknown> | null) || null;
      const smartCtx = {
        category,
        swatchProfile: swatchProfile as { opacity?: 'sheer'|'translucent'|'opaque'; pattern_type?: string; complexity?: string } | null,
        attempt: job.attempt,
        useProModel,
      };
      if (effectiveMode === 'from_scratch') {
        const smart = await generateImageSmart({
          swatchImageBase64: swatchBase64,
          swatchMimeType: 'image/png',
          promptText: prompt,
          temperature,
          useProModel,
        }, smartCtx);
        result = smart;
        providerUsed = smart.providerUsed;
        modelIdUsed = smart.modelIdUsed;
        costUsdActual = smart.costEstimateUsd;
        logPipelineEvent(job.id, 'PROVIDER_USED', smart.providerUsed, { cost_usd: smart.costEstimateUsd, model_id: smart.modelIdUsed });
      } else {
        const smart = await generateImageSmart({
          heroImageBase64: heroBase64,
          heroMimeType: isBrandOnly ? 'image/png' : (job.hero_shot.mime_type || 'image/png'),
          swatchImageBase64: swatchBase64,
          swatchMimeType: 'image/png',
          promptText: prompt,
          temperature,
          useProModel,
        }, smartCtx);
        result = smart;
        providerUsed = smart.providerUsed;
        modelIdUsed = smart.modelIdUsed;
        costUsdActual = smart.costEstimateUsd;
        logPipelineEvent(job.id, 'PROVIDER_USED', smart.providerUsed, { cost_usd: smart.costEstimateUsd, model_id: smart.modelIdUsed });
      }
    }

    if (!result.success || !result.imageBase64) {
      logPipelineEvent(job.id, 'GENERATION_DONE', 'failed', { error: result.error, duration_ms: result.durationMs });
      throw new Error(result.error || 'Generation failed');
    }

    logPipelineEvent(job.id, 'GENERATION_DONE', 'success', { duration_ms: result.durationMs });

    // Post-process: ensure 1200x1200 RGB
    const rawBuffer = Buffer.from(result.imageBase64, 'base64');
    let imageBuffer = await ensureOutputSpec(rawBuffer, 1200);

    // ── Pixel-perfect overlay restore ──
    // Gemini edit mode re-renders text/logos with subtle font drift (and
    // sometimes outright color changes — e.g. white BANVA HOME® logo
    // re-rendered in blue) even when the prompt explicitly says "preserve
    // overlays". For any edit-mode shot whose hero carries infographic
    // overlays (BANVA branding, dimension cotas, headlines), copy the
    // original hero pixels into the result for each detected text bbox.
    // Safe across shot types because edit mode preserves composition and
    // the composite is a no-op when no overlays exist.
    //
    // Excepción: sabanas. Flash en edit-mode ya preserva panel/logo/badge
    // del hero sin ayuda, y el chroma-key del overlay sobre tela polar con
    // highlights blancos los pega como smudges sobre la sabana teñida.
    // Job 115caddb (mayo 2026): mismo hero+swatch que Job 13396077 (clean),
    // pero overlay introdujo manchas blancas curvas siguiendo los pliegues.
    // Ver scripts/test-overlay-old-vs-new.ts para reproducción.
    const heroHasOverlays = (job.hero_shot?.text_elements as unknown[] | null)?.length ?? 0;
    if (
      !isBrandOnly &&
      effectiveMode === 'edit' &&
      heroHasOverlays > 0 &&
      job.hero_shot?.id &&
      category !== 'sabanas'
    ) {
      try {
        type Bbox = { text?: string; x: number; y: number; width: number; height: number };
        const heroShotRow = job.hero_shot as { id: string; text_bboxes?: Bbox[] | null; mime_type?: string | null };
        let bboxes: Bbox[] | null = (heroShotRow.text_bboxes as Bbox[] | null) ?? null;
        if (!bboxes || bboxes.length === 0) {
          const heroMeta = await (await import('sharp')).default(heroBuffer).metadata();
          const detected = await detectTextBboxes(
            heroBuffer.toString('base64'),
            heroShotRow.mime_type || 'image/png',
            heroMeta.width || 1200,
            heroMeta.height || 1200,
          );
          if (detected && detected.length > 0) {
            bboxes = detected;
            supabase
              .from('hero_shots')
              .update({ text_bboxes: detected })
              .eq('id', heroShotRow.id)
              .then(() => {}, () => {});
            logPipelineEvent(job.id, 'OVERLAY_BBOXES_CACHED', `${detected.length} bboxes`);
          }
        }
        if (bboxes && bboxes.length > 0) {
          imageBuffer = await compositeHeroOverlays(heroBuffer, imageBuffer, bboxes);
          logPipelineEvent(job.id, 'OVERLAY_RESTORED', `${bboxes.length} regions composited from hero`);
        }
      } catch (overlayErr) {
        console.error('[process-next] Hero overlay restore failed (non-blocking):', overlayErr);
        logPipelineEvent(job.id, 'OVERLAY_RESTORE_FAILED', overlayErr instanceof Error ? overlayErr.message : 'unknown');
      }
    }

    // Brand logo overlay: DISABLED. The user applies the logo manually via
    // the Brand button in the results UI (BRAND_ONLY regeneration mode).
    // Automatic overlay caused QA false positives when the hero didn't have
    // a logo but the output did.

    // ── Swatch Fidelity Verification (Gemini 2.5 Pro) — blocks bad images ──
    // Skip for multi-pass (each pass is targeted, verification would exceed 60s timeout)
    // Skip for infografias (color-only edit, verifier expects full pattern match)
    const isMultiPass = !!promptMetadata.multipass;
    const isInfografia = effectiveShotType === 'infografia';
    if (isInfografia) {
      logPipelineEvent(job.id, 'VERIFICATION', 'skipped (infografia color-only edit)');
    }

    // ── EARLY UPLOAD ──
    // Persist the generated image BEFORE expensive verification so we survive
    // a Vercel 60s timeout mid-verifier with the image visible in the UI.
    // The final upload block below re-uploads to a sluggified filename on success.
    try {
      const earlyPath = `projects/${project.id}/generated/${job.id}.png`;
      await supabase.storage.from('images').upload(earlyPath, imageBuffer, {
        contentType: result.imageMimeType || 'image/png',
        upsert: true,
      });
      // attemptOwnedUpdate logs STALE_CLAIM_ABORTED if we lost the claim.
      // Don't bail here — the upload already happened and the next owning
      // worker will overwrite output_storage_path on its final write anyway.
      await attemptOwnedUpdate(supabase, job.id, workerId, {
        output_storage_path: earlyPath,
      }, 'early-upload-path');
      logPipelineEvent(job.id, 'EARLY_UPLOAD', earlyPath);
    } catch (earlyErr) {
      console.error('[process-next] Early upload failed (non-blocking):', earlyErr);
    }

    let verificationRaw: Record<string, unknown> | null = null;
    // Delta-E short-circuit: before hitting the expensive VLM verifier
    // (~$0.10/call), compute a numeric perceptual color distance between
    // the cropped swatch and the generated output's product region. If the
    // distance is > DELTA_E_REJECT_THRESHOLD, the color is visibly wrong
    // and we skip the VLM entirely, saving the call + triggering retry with
    // targeted feedback. Research: research/2026-04-14-...:163 — Delta-E is
    // "crítico para textiles" in e-commerce QA pipelines.
    const DELTA_E_LOG_ONLY = false; // set true during calibration period
    const DELTA_E_REJECT_THRESHOLD = 25; // LAB CIE76; calibrated conservatively
    // Skip whole-image Delta-E when the category declares preserve_surfaces —
    // those are scenes where the product occupies only part of the frame
    // (alfombras in a living-room, cortinas, etc). The center-crop color
    // sample will mix target + preserved surfaces and produce false positives.
    // Rely on the VLM verifier's color_match check (it can segment).
    const skipDeltaE = (strategy.preserve_surfaces?.length ?? 0) > 0;
    let deltaEResult: { deltaE: number; swatchRgb: { r: number; g: number; b: number }; outputRgb: { r: number; g: number; b: number }; swatchSource: 'pixel' | 'vlm' | 'cache'; outputSource: 'pixel' | 'vlm' } | null = null;
    if (!isBrandOnly && !isMultiPass && !isInfografia && !skipDeltaE) {
      try {
        const swatchBufForDrift = Buffer.from(swatchBase64ForVerification, 'base64');
        deltaEResult = await computeSwatchOutputDeltaE(swatchBufForDrift, imageBuffer, {
          swatchOriginalBuffer: originalSwatchBuffer,
          swatchOriginalMime: job.swatch.mime_type || 'image/jpeg',
          cachedSwatchHex: job.swatch.dominant_color_hex || null,
          rejectThreshold: DELTA_E_REJECT_THRESHOLD,
        });
        logPipelineEvent(job.id, 'COLOR_DELTA_E', deltaEResult.deltaE.toFixed(1), {
          swatch_rgb: deltaEResult.swatchRgb,
          output_rgb: deltaEResult.outputRgb,
          swatch_source: deltaEResult.swatchSource,
          output_source: deltaEResult.outputSource,
        });
        // Cache VLM result for future jobs with this swatch
        if (deltaEResult.swatchSource === 'vlm' && job.swatch.id) {
          const hex = `#${deltaEResult.swatchRgb.r.toString(16).padStart(2, '0')}${deltaEResult.swatchRgb.g.toString(16).padStart(2, '0')}${deltaEResult.swatchRgb.b.toString(16).padStart(2, '0')}`.toUpperCase();
          Promise.resolve(supabase.from('swatches').update({ dominant_color_hex: hex }).eq('id', job.swatch.id))
            .catch((err: unknown) => console.error('[process-next] Failed to cache VLM swatch hex:', err));
        }
      } catch (driftErr) {
        console.error('[process-next] Delta-E computation failed (non-blocking):', driftErr);
      }
    }
    // Early-reject on color drift (before paying for VLM verifier)
    if (!DELTA_E_LOG_ONLY && deltaEResult && deltaEResult.deltaE > DELTA_E_REJECT_THRESHOLD && job.attempt < 4) {
      const dE = deltaEResult.deltaE.toFixed(1);
      const debugPath = `projects/${project.id}/generated/_debug/${job.id}_attempt${job.attempt}_color_drift.png`;
      let debugSaved = false;
      try {
        await supabase.storage.from('images').upload(debugPath, imageBuffer, {
          contentType: result.imageMimeType || 'image/png',
          upsert: true,
        });
        debugSaved = true;
      } catch {}
      const feedback = `Color drift detected: Delta-E=${dE} vs swatch (threshold ${DELTA_E_REJECT_THRESHOLD}). The fabric color in the output does not match the swatch. Apply the EXACT color of Image 2 — same hue, same saturation, same lightness.`;
      logPipelineEvent(job.id, 'VERIFICATION', 'COLOR_DRIFT_REJECT', { delta_e: deltaEResult.deltaE });
      logPipelineEvent(job.id, 'VERIFICATION_RETRY', feedback, { new_attempt: job.attempt + 1 });
      console.log(`[process-next] ⚠ Color drift REJECT ${job.swatch.name} (ΔE=${dE})`);
      await attemptOwnedUpdate(supabase, job.id, workerId, {
        status: 'pending',
        attempt: job.attempt + 1,
        qa_feedback: `[Delta-E ${dE}] ${feedback}`,
        prompt_metadata: { ...promptMetadata, color_delta_e: deltaEResult.deltaE },
        ...(debugSaved ? { output_storage_path: debugPath } : {}),
      }, 'color-drift-retry');
      return { chain: true, triggerQA: false };
    }
    if (!isBrandOnly && !isMultiPass && !isInfografia) {
      try {
        const verifyStart = Date.now();
        const generatedB64 = imageBuffer.toString('base64');
        // Use the cropped (pre-flatten) swatch for verification — the AI flattener
        // can misinterpret textures, causing false passes when both the flattened
        // swatch and generated image share the same invented pattern.
        const verification = await verifySwatch(
          swatchBase64ForVerification,
          generatedB64,
          heroBase64,
          job.swatch.name,
          swatchPatternDescription,
          category,
        );
        if (verification) {
          promptMetadata.verification_score = verification.score;
          promptMetadata.verification_pass = verification.pass;
          promptMetadata.verification_issues = verification.issues;
          if (deltaEResult) promptMetadata.color_delta_e = deltaEResult.deltaE;
          verificationRaw = {
            score: verification.score,
            pass: verification.pass,
            issues: verification.issues,
            feedback: verification.feedback,
            checks: verification.checks || null,
            raw_response: verification.rawResponse || null,
            pattern_description: swatchPatternDescription,
            duration_ms: Date.now() - verifyStart,
            attempt: job.attempt,
            delta_e: deltaEResult?.deltaE ?? null,
            delta_e_swatch_rgb: deltaEResult?.swatchRgb ?? null,
            delta_e_output_rgb: deltaEResult?.outputRgb ?? null,
          };
          if (!verification.pass && job.attempt < 4) {
            // BLOCK: verification failed, auto-retry with specific feedback.
            // Save a debug copy of the rejected image so we can inspect what
            // Gemini actually produced (otherwise it's lost on retry).
            const debugPath = `projects/${project.id}/generated/_debug/${job.id}_attempt${job.attempt}_rejected.png`;
            let debugSaved = false;
            try {
              await supabase.storage.from('images').upload(debugPath, imageBuffer, {
                contentType: result.imageMimeType || 'image/png',
                upsert: true,
              });
              logPipelineEvent(job.id, 'DEBUG_SAVED_REJECTED', debugPath);
              debugSaved = true;
            } catch (saveErr) {
              console.error('[process-next] Debug save failed (non-blocking):', saveErr);
            }
            const feedback = verification.feedback || verification.issues.join('. ');
            logPipelineEvent(job.id, 'VERIFICATION', 'FAIL', { score: verification.score, issues: verification.issues });
            logPipelineEvent(job.id, 'VERIFICATION_RETRY', feedback, { new_attempt: job.attempt + 1 });
            console.log(`[process-next] ⚠ Verification BLOCKED ${job.swatch.name} (score: ${verification.score}): ${feedback}`);
            // Preserve the last rejected image as output_storage_path so the UI can render
            // the job even if it hits max retries and flags without ever producing an approved
            // output. Without this, flagged jobs show "Sin imagen" in results.
            await attemptOwnedUpdate(supabase, job.id, workerId, {
              status: 'pending',
              attempt: job.attempt + 1,
              qa_feedback: `[Verifier 2.5 Pro] ${feedback}`,
              prompt_metadata: promptMetadata,
              verification_raw: verificationRaw,
              ...(debugSaved ? { output_storage_path: debugPath } : {}),
            }, 'verifier-retry');
            // Chain continues — process-next will pick this job up again with the feedback
            return { chain: true, triggerQA: false };
          } else if (!verification.pass) {
            // Max retries reached — flag for human review
            logPipelineEvent(job.id, 'VERIFICATION', 'FAIL_MAX_RETRIES', { score: verification.score, feedback: verification.feedback });
            console.log(`[process-next] ⚠ Verification FAILED (max retries) for ${job.swatch.name}: ${verification.feedback}`);
            promptMetadata.verification_feedback = verification.feedback;
          } else {
            logPipelineEvent(job.id, 'VERIFICATION', 'PASS', { score: verification.score });
            console.log(`[process-next] ✓ Verification passed for ${job.swatch.name} (score: ${verification.score})`);
          }
        }
      } catch (verifyErr) {
        console.error('[process-next] Verification failed (non-blocking):', verifyErr);
      }
    }

    // Upload result — name includes SKU + color + shot type for searchability
    const sku = job.swatch?.sku_suffix || '';
    const color = (job.swatch?.name || '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    const shotType = (job.hero_shot?.shot_type || 'gen').replace(/[^a-zA-Z0-9]+/g, '-');
    const attempt = job.attempt + 1;
    const slug = [sku, color, shotType, `v${attempt}`].filter(Boolean).join('_');
    const outputPath = `projects/${project.id}/generated/${slug}_${job.id.substring(0, 8)}.png`;

    await supabase.storage
      .from('images')
      .upload(outputPath, imageBuffer, {
        contentType: result.imageMimeType || 'image/png',
        upsert: true,
      });

    logPipelineEvent(job.id, 'UPLOAD', outputPath);

    // If this generation is not brand-only, any existing pre-brand backup
    // is now stale (it was the fabric of a previous brand pass and no
    // longer matches the new output). Dual-route sync with regenerateJob.
    // Repro: job 64c4c9d1 — regen with a new swatch left the old pre-brand
    // backup on disk, and the next Brand click reverted to the old fabric.
    if (!isBrandOnly) {
      const preBrandPath = `projects/${project.id}/generated/${job.id}_pre_brand.png`;
      try {
        await supabase.storage.from('images').remove([preBrandPath]);
        logPipelineEvent(job.id, 'PRE_BRAND_INVALIDATED', 'nuevo output reemplaza backup');
      } catch {
        // Swallow: remove on missing file is a no-op in Supabase.
      }
    }

    // BRAND_ONLY: auto-approve (skip QA — saves 1 Flash call + 3 image downloads)
    // Regular: send to QA for evaluation
    const finalStatus = isBrandOnly ? 'approved' : 'qa_pending';

    const ownedFinal = await attemptOwnedUpdate(supabase, job.id, workerId, {
      status: finalStatus,
      output_storage_path: outputPath,
      generation_time_ms: result.durationMs,
      provider_used: providerUsed,
      model_id: modelIdUsed,
      cost_usd_actual: costUsdActual,
      _telemetry_source: 'sprint_1_runtime',
      error_message: null,
      // ─── Observability v1 captures ───
      swatch_pattern_text: swatchPatternDescription,
      verification_raw: verificationRaw,
      gemini_response_meta: result.meta || null,
      prompt_metadata: promptMetadata,
      ...(isBrandOnly ? { qa_score: 0.95, qa_feedback: 'Auto-approved (BRAND_ONLY)' } : {}),
    }, 'final-write-after-generation');
    if (!ownedFinal) {
      // Lost the claim mid-flight — another worker processed this job.
      // The 200s of generation work is wasted but we don't want to
      // overwrite their result. Chain continues for the next pending job.
      return { chain: true, triggerQA: false };
    }

    logPipelineEvent(job.id, 'STATUS', finalStatus, { qa_triggered: !isBrandOnly });

    // Increment API call counter (non-blocking — column may not exist yet)
    Promise.resolve(
      supabase.from('generation_jobs')
        .update({ total_api_calls: (job.total_api_calls || 0) + 1 })
        .eq('id', job.id)
    ).catch(() => {});

    console.log(`[process-next] Job ${job.id.substring(0, 8)} done — status: ${finalStatus}`);

    // Signal: chain to next + trigger QA (skip QA trigger for BRAND_ONLY)
    return { chain: true, triggerQA: !isBrandOnly };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logPipelineEvent(job.id, 'ERROR', errorMessage);

    const ownedError = await attemptOwnedUpdate(supabase, job.id, workerId, {
      status: 'error',
      error_message: errorMessage,
    }, 'catch-error-write');
    if (!ownedError) {
      // Lost the claim mid-flight; another worker is handling this job
      // and we shouldn't clobber its state with our error. Chain continues.
      return { chain: true, triggerQA: false };
    }

    await supabase
      .from('generation_batches')
      .update({
        completed_count: (batch.completed_count || 0) + 1,
        error_count: (batch.error_count || 0) + 1,
      })
      .eq('id', batchId);

    console.error(`[process-next] Job ${job.id.substring(0, 8)} error:`, errorMessage);

    // Still chain to try the next job
    return { chain: true, triggerQA: false };
  }
}

function getBaseUrl(): string {
  return process.env.APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'http://localhost:3000';
}

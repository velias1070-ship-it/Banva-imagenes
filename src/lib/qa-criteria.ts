// ─────────────────────────────────────────────────────────────────────────────
// QA Criteria — Scoring weights, thresholds, and action determination
// ─────────────────────────────────────────────────────────────────────────────
// hero_contamination is an INDEPENDENT escalation trigger, NOT part of the
// weighted score. The 7 original weights sum to 1.0.
// ─────────────────────────────────────────────────────────────────────────────

import type { QADetail } from '@/types/database';
import type { CategoryStrategy } from './category-strategy';

export interface QACriteria {
  auto_approve_threshold: number;   // >= this → approved
  retry_threshold: number;          // >= this (and < approve) → retry
  max_retries: number;
  batch_halt_flagged_percent: number;
  batch_halt_min_processed: number;
  hero_contamination_escalation_threshold: number;

  scoring_weights: {
    product_fidelity: number;
    color_accuracy: number;
    composition_match: number;
    visual_quality: number;
    resolution: number;
    aspect_ratio: number;
    ml_compliance: number;
  };

  product_fidelity_blocker: boolean; // If true, low fidelity → flag regardless of score
  product_fidelity_blocker_threshold: number; // Below this → flag
}

// ─────────────────────────────────────────────────────────────────────────────
// Default criteria (hardcoded — no external JSON dependency)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CRITERIA: QACriteria = {
  auto_approve_threshold: 0.80,
  retry_threshold: 0.60,
  max_retries: 2,
  batch_halt_flagged_percent: 0.20,
  batch_halt_min_processed: 5,
  hero_contamination_escalation_threshold: 0.6,

  scoring_weights: {
    product_fidelity: 0.30,
    color_accuracy: 0.20,
    composition_match: 0.20,
    visual_quality: 0.15,
    resolution: 0.05,
    aspect_ratio: 0.05,
    ml_compliance: 0.05,
  },

  product_fidelity_blocker: true,
  product_fidelity_blocker_threshold: 0.40,
};

// ─────────────────────────────────────────────────────────────────────────────
// Getter (allows future override from DB or config file)
// ─────────────────────────────────────────────────────────────────────────────

export function getQACriteria(): QACriteria {
  return DEFAULT_CRITERIA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute weighted score from QADetail (7 dimensions, NOT hero_contamination)
// ─────────────────────────────────────────────────────────────────────────────

export function computeWeightedScore(detail: QADetail): number {
  const w = DEFAULT_CRITERIA.scoring_weights;

  const score =
    detail.product_fidelity * w.product_fidelity +
    detail.color_accuracy * w.color_accuracy +
    detail.composition_match * w.composition_match +
    detail.visual_quality * w.visual_quality +
    detail.resolution * w.resolution +
    detail.aspect_ratio * w.aspect_ratio +
    detail.ml_compliance * w.ml_compliance;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

// ─────────────────────────────────────────────────────────────────────────────
// Determine action based on score, fidelity, and contamination
// ─────────────────────────────────────────────────────────────────────────────
// Returns: 'approve' | 'retry' | 'flag'
// Also returns whether to escalate generation mode (hero_contamination trigger)
// ─────────────────────────────────────────────────────────────────────────────

export interface QAAction {
  action: 'approve' | 'retry' | 'flag';
  escalate: boolean;  // true if hero_contamination triggered escalation
  reason: string;
}

export function determineAction(
  score: number,
  detail: QADetail,
  strategy: CategoryStrategy,
  attempt: number
): QAAction {
  const criteria = DEFAULT_CRITERIA;

  // 1. Product fidelity blocker — low fidelity = flag immediately
  if (
    criteria.product_fidelity_blocker &&
    detail.product_fidelity < criteria.product_fidelity_blocker_threshold
  ) {
    return {
      action: 'flag',
      escalate: false,
      reason: `Product fidelity ${(detail.product_fidelity * 100).toFixed(0)}% below blocker threshold ${(criteria.product_fidelity_blocker_threshold * 100).toFixed(0)}%`,
    };
  }

  // 2. Hero contamination — independent escalation trigger
  if (detail.hero_contamination > criteria.hero_contamination_escalation_threshold) {
    // If we can still retry, retry with escalation
    if (attempt < criteria.max_retries && strategy.retry_escalation) {
      return {
        action: 'retry',
        escalate: true,
        reason: `Hero contamination ${(detail.hero_contamination * 100).toFixed(0)}% > ${(criteria.hero_contamination_escalation_threshold * 100).toFixed(0)}% — escalating to ${strategy.retry_escalation}`,
      };
    }
    // Max retries reached — flag
    return {
      action: 'flag',
      escalate: false,
      reason: `Hero contamination ${(detail.hero_contamination * 100).toFixed(0)}% after ${attempt} attempts — max retries reached`,
    };
  }

  // 3. Score-based decision
  if (score >= criteria.auto_approve_threshold) {
    return {
      action: 'approve',
      escalate: false,
      reason: `Score ${(score * 100).toFixed(0)}% >= ${(criteria.auto_approve_threshold * 100).toFixed(0)}%`,
    };
  }

  if (score >= criteria.retry_threshold) {
    // Can we still retry?
    if (attempt < criteria.max_retries) {
      return {
        action: 'retry',
        escalate: false,
        reason: `Score ${(score * 100).toFixed(0)}% between retry (${(criteria.retry_threshold * 100).toFixed(0)}%) and approve (${(criteria.auto_approve_threshold * 100).toFixed(0)}%) thresholds`,
      };
    }
    // Max retries reached — flag
    return {
      action: 'flag',
      escalate: false,
      reason: `Score ${(score * 100).toFixed(0)}% after ${attempt} attempts — max retries reached`,
    };
  }

  // Below retry threshold — flag
  return {
    action: 'flag',
    escalate: false,
    reason: `Score ${(score * 100).toFixed(0)}% < retry threshold ${(criteria.retry_threshold * 100).toFixed(0)}%`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if batch should halt
// ─────────────────────────────────────────────────────────────────────────────

export function shouldHaltBatch(
  flaggedCount: number,
  completedCount: number
): { halt: boolean; reason?: string } {
  const criteria = DEFAULT_CRITERIA;

  if (completedCount < criteria.batch_halt_min_processed) {
    return { halt: false };
  }

  const flaggedPercent = flaggedCount / completedCount;

  if (flaggedPercent > criteria.batch_halt_flagged_percent) {
    return {
      halt: true,
      reason: `${(flaggedPercent * 100).toFixed(0)}% flagged (${flaggedCount}/${completedCount}) exceeds ${(criteria.batch_halt_flagged_percent * 100).toFixed(0)}% threshold`,
    };
  }

  return { halt: false };
}

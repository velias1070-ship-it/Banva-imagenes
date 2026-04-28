/**
 * FAL adapter — STUB. Reserved for FLUX.2 Pro / Seedream when there's a
 * concrete reason to enable a third-party provider.
 *
 * Calling .generate() throws. Implement when the routing rules actually
 * want to send traffic here (Sprint 3 or whenever a candidate model
 * proves itself in the golden set).
 */

import type { ImageGenerator, UnifiedRequest, UnifiedResult } from './types';

export const falStubProvider: ImageGenerator = {
  modelId: 'fal-stub',
  providerFamily: 'fal',
  costPerImageUsd: 0,
  async generate(_req: UnifiedRequest): Promise<UnifiedResult> {
    throw new Error('fal provider not implemented yet');
  },
};

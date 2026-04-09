import { createAdminClient } from '@/lib/supabase/admin';

export interface PipelineEvent {
  ts: string;       // ISO timestamp
  event: string;    // event name
  detail?: string;  // short description
  data?: Record<string, unknown>;  // optional structured data
}

/**
 * Append an event to a job's pipeline_log (JSONB array).
 * Non-blocking — fire and forget. If the column doesn't exist yet,
 * the call silently fails without affecting the pipeline.
 *
 * Uses read-then-write to append atomically.
 * Supabase returns PromiseLike, so we use void + try/catch (never .catch()).
 */
export function logPipelineEvent(
  jobId: string,
  event: string,
  detail?: string,
  data?: Record<string, unknown>,
): void {
  const entry: PipelineEvent = {
    ts: new Date().toISOString(),
    event,
    ...(detail ? { detail } : {}),
    ...(data ? { data } : {}),
  };

  // Wrap in async IIFE — non-blocking, never throws
  void (async () => {
    try {
      const supabase = createAdminClient();
      const { data: job } = await supabase
        .from('generation_jobs')
        .select('pipeline_log')
        .eq('id', jobId)
        .single();

      const log: PipelineEvent[] = Array.isArray(job?.pipeline_log) ? job.pipeline_log : [];
      log.push(entry);

      await supabase
        .from('generation_jobs')
        .update({ pipeline_log: log })
        .eq('id', jobId);
    } catch {
      // Silently ignore — logging must never break the pipeline
    }
  })();
}

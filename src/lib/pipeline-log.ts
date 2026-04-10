import { createAdminClient } from '@/lib/supabase/admin';

export interface PipelineEvent {
  ts: string;       // ISO timestamp
  event: string;    // event name
  detail?: string;  // short description
  data?: Record<string, unknown>;  // optional structured data
}

/**
 * Append an event to a job's pipeline_log (JSONB array).
 * Non-blocking — fire and forget.
 *
 * Uses atomic Postgres jsonb concat (||) via RPC to avoid lost events when
 * many events fire in quick succession (the previous read-then-write pattern
 * raced when several events fired within the supabase round-trip window).
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
      // Atomic append via RPC. The function `append_pipeline_event` runs:
      //   UPDATE generation_jobs
      //     SET pipeline_log = COALESCE(pipeline_log, '[]'::jsonb) || $2::jsonb
      //     WHERE id = $1
      const rpcResult = await supabase.rpc('append_pipeline_event', {
        p_job_id: jobId,
        p_entry: entry,
      });
      // Fallback if RPC isn't installed yet — use unsafe read-write
      if (rpcResult.error) {
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
      }
    } catch {
      // Silently ignore — logging must never break the pipeline
    }
  })();
}

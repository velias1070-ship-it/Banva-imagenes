import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { batchGenerate } from '@/lib/inngest/functions/batch-generate';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [batchGenerate],
});

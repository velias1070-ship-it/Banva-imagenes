/**
 * Sprint 4 prelim — discover real case_signatures in prod.
 * Buckets by (category, case_signature) and counts jobs with usable hero+swatch
 * in terminal status. Output drives the YAML suite re-population.
 */
import { createClient } from '@supabase/supabase-js';

interface JobRow {
  id: string;
  status: string;
  case_signature: string | null;
  hero_shot_id: string | null;
  swatch_id: string | null;
  hero_shot: { storage_path: string | null } | null;
  swatch: { storage_path: string | null } | null;
  batch: { project: { category: string | null } | null } | null;
}

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const TERMINAL = ['approved', 'flagged', 'error', 'completed'];
  const PAGE = 1000;
  let offset = 0;
  const all: JobRow[] = [];
  while (true) {
    const { data, error } = await supabase
      .from('generation_jobs')
      .select('id, status, case_signature, hero_shot_id, swatch_id, hero_shot:hero_shots(storage_path), swatch:swatches(storage_path), batch:generation_batches(project:projects(category))')
      .in('status', TERMINAL)
      .not('case_signature', 'is', null)
      .range(offset, offset + PAGE - 1);
    if (error) { console.error('ERROR:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...(data as unknown as JobRow[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  const usable = all.filter((j) => j.hero_shot?.storage_path && j.swatch?.storage_path);
  console.log(`Total terminal jobs with case_signature: ${all.length}`);
  console.log(`With usable hero+swatch:                 ${usable.length}`);
  console.log();

  // Group by category > signature
  const byCat = new Map<string, Map<string, { total: number; statuses: Record<string, number> }>>();
  for (const j of usable) {
    const cat = j.batch?.project?.category || 'unknown';
    const sig = j.case_signature!;
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const sigMap = byCat.get(cat)!;
    const cur = sigMap.get(sig) || { total: 0, statuses: {} };
    cur.total += 1;
    cur.statuses[j.status] = (cur.statuses[j.status] || 0) + 1;
    sigMap.set(sig, cur);
  }

  const cats = Array.from(byCat.keys()).sort();
  for (const cat of cats) {
    const sigMap = byCat.get(cat)!;
    const sigs = Array.from(sigMap.entries()).sort((a, b) => b[1].total - a[1].total);
    console.log(`── ${cat} (${sigs.reduce((s, [, v]) => s + v.total, 0)} jobs, ${sigs.length} signatures) ──`);
    for (const [sig, v] of sigs.slice(0, 10)) {
      const breakdown = Object.entries(v.statuses).map(([s, c]) => `${s}=${c}`).join(' ');
      console.log(`  ${String(v.total).padStart(4)}  ${sig.padEnd(50)}  [${breakdown}]`);
    }
    if (sigs.length > 10) console.log(`  ... and ${sigs.length - 10} more signatures`);
    console.log();
  }
}

main();

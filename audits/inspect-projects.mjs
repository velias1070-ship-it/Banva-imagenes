import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function log(title, rows) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(rows, null, 2));
}

// Discover what tables exist by trying several known ones
const candidates = ['generation_jobs', 'jobs', 'ml_listings', 'ml_item_project', 'swatches', 'hero_shots', 'batches'];
const tableStatus = {};
for (const t of candidates) {
  const { data, error } = await supa.from(t).select('*', { count: 'exact', head: true });
  tableStatus[t] = error ? `ERR: ${error.message}` : `OK`;
}
log('TABLE DISCOVERY', tableStatus);

// Get all projects
const { data: projects, error: e1 } = await supa
  .from('projects')
  .select('id, name, category, sku_base, status, created_at, updated_at')
  .order('created_at', { ascending: false });
if (e1) throw e1;
console.log(`\nTOTAL PROJECTS: ${projects.length}`);

// Full project list for context
log('ALL PROJECTS', projects.map(p => ({
  name: p.name,
  category: p.category,
  sku_base: p.sku_base,
  status: p.status,
  age_days: Math.round((Date.now() - new Date(p.created_at).getTime()) / (86400000)),
})));

// Try jobs
try {
  const { data: jobs, error } = await supa
    .from('generation_jobs')
    .select('project_id, status');
  if (error) {
    console.log('\ngeneration_jobs ERROR:', error.message);
  } else {
    console.log(`\nTOTAL JOBS: ${jobs.length}`);
    const byStatus = {};
    const jobsByProject = {};
    for (const j of jobs) {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1;
      jobsByProject[j.project_id] = jobsByProject[j.project_id] || { total: 0, approved: 0 };
      jobsByProject[j.project_id].total++;
      if (j.status === 'approved') jobsByProject[j.project_id].approved++;
    }
    log('JOBS BY STATUS', byStatus);

    // completion per project
    let empty = 0, partial = 0, full = 0, zero = 0;
    const projectCompletion = [];
    for (const p of projects) {
      const pj = jobsByProject[p.id] || { total: 0, approved: 0 };
      if (pj.total === 0) empty++;
      else if (pj.approved === 0) zero++;
      else if (pj.approved === pj.total) full++;
      else partial++;
      projectCompletion.push({
        name: p.name,
        total: pj.total,
        approved: pj.approved,
        pct: pj.total ? Math.round(pj.approved / pj.total * 100) : 0,
      });
    }
    log('PROJECT COMPLETION', { empty_no_jobs: empty, zero_approved: zero, partially_approved: partial, fully_approved: full });
    log('PROJECT COMPLETION DETAIL', projectCompletion.sort((a, b) => b.total - a.total).slice(0, 20));
  }
} catch (e) {
  console.log('\ngeneration_jobs THROW:', e.message);
}

// Try ml_listings variants
for (const name of ['ml_listings', 'project_ml_listings', 'ml_item_project']) {
  const { data, error } = await supa.from(name).select('*').limit(3);
  if (!error) {
    console.log(`\n${name} FIRST ROW KEYS:`, data[0] ? Object.keys(data[0]) : 'empty');
    const { count } = await supa.from(name).select('*', { count: 'exact', head: true });
    console.log(`${name} ROW COUNT:`, count);
  }
}

console.log('\nDONE');

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('project_id') || 'f047dcc1-1c96-440c-99af-e7c0af622f89';

  const supabase = createAdminClient();

  // Step 1: Get project with brand_id
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, name, brand_id')
    .eq('id', projectId)
    .single();

  if (projErr) return NextResponse.json({ step: 'project', error: projErr.message });

  const brandId = project?.brand_id;
  if (!brandId) return NextResponse.json({ step: 'project', project: project?.name, brand_id: null, msg: 'No brand assigned' });

  // Step 2: Try to read brand with admin client
  const { data: brand, error: brandErr } = await supabase
    .from('brands')
    .select('id, name, logo_storage_path, apply_logo_overlay')
    .eq('id', brandId)
    .single();

  if (brandErr) return NextResponse.json({ step: 'brand_query', brand_id: brandId, error: brandErr.message, code: brandErr.code, hint: brandErr.hint });

  if (!brand) return NextResponse.json({ step: 'brand_query', brand_id: brandId, error: 'Brand not found (null)' });

  // Step 3: Try to download logo
  let logoStatus = 'not_tested';
  if (brand.logo_storage_path) {
    const { data: logoData, error: logoErr } = await supabase.storage
      .from('images')
      .download(brand.logo_storage_path);

    if (logoErr) {
      logoStatus = `download_error: ${logoErr.message}`;
    } else if (logoData) {
      const buf = await logoData.arrayBuffer();
      logoStatus = `ok (${buf.byteLength} bytes)`;
    }
  }

  return NextResponse.json({
    step: 'all_ok',
    project: project.name,
    brand_id: brandId,
    brand_name: brand.name,
    logo_path: brand.logo_storage_path,
    logo_overlay: brand.apply_logo_overlay,
    logo_download: logoStatus,
  });
}

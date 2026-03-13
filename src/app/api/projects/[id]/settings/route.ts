import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { getProjectSettings, DEFAULT_PROJECT_SETTINGS } from '@/lib/project-settings';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET — Return current settings (merged defaults + overrides)
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: project, error } = await supabase
    .from('projects')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (error || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const settings = getProjectSettings(project.metadata);
  const hasCustomSettings = !!(project.metadata as Record<string, unknown>)?.settings;

  return NextResponse.json({
    settings,
    defaults: DEFAULT_PROJECT_SETTINGS,
    is_customized: hasCustomSettings,
  });
}

// PUT — Save settings overrides to project.metadata.settings
export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const body = await request.json();

  // Get current project metadata
  const { data: project, error: fetchError } = await supabase
    .from('projects')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (fetchError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Merge existing metadata with new settings
  const currentMetadata = (project.metadata || {}) as Record<string, unknown>;
  const newMetadata = {
    ...currentMetadata,
    settings: body.settings || body,
  };

  // Validate by running through getProjectSettings (applies clamping/normalization)
  const validated = getProjectSettings(newMetadata);

  // Store the validated settings
  newMetadata.settings = validated;

  const { error: updateError } = await supabase
    .from('projects')
    .update({
      metadata: newMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    settings: validated,
    is_customized: true,
  });
}

// DELETE — Reset settings to defaults (remove overrides)
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: project, error: fetchError } = await supabase
    .from('projects')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (fetchError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const currentMetadata = (project.metadata || {}) as Record<string, unknown>;
  delete currentMetadata.settings;

  const { error: updateError } = await supabase
    .from('projects')
    .update({
      metadata: currentMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    settings: DEFAULT_PROJECT_SETTINGS,
    is_customized: false,
  });
}

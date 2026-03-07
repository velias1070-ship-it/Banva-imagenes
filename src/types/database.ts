export type ProjectStatus = 'draft' | 'active' | 'archived';
export type ShotType = 'main' | 'lifestyle' | 'detail' | 'doblada' | 'flatlay';
export type BatchStatus = 'pending' | 'generating' | 'qa' | 'retrying' | 'completed' | 'failed' | 'halted';
export type JobStatus = 'pending' | 'prompt_built' | 'generating' | 'qa_pending' | 'approved' | 'retry' | 'flagged' | 'error';

export interface Project {
  id: string;
  name: string;
  slug: string;
  category: string;
  sku_base: string | null;
  description: string | null;
  status: ProjectStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HeroShot {
  id: string;
  project_id: string;
  filename: string;
  storage_path: string;
  shot_type: ShotType;
  display_order: number;
  width: number | null;
  height: number | null;
  file_size_kb: number | null;
  mime_type: string | null;
  created_at: string;
}

export interface Swatch {
  id: string;
  project_id: string;
  name: string;
  sku_suffix: string | null;
  color_description: string | null;
  storage_path: string;
  dominant_color_hex: string | null;
  display_order: number;
  file_size_kb: number | null;
  created_at: string;
}

export interface GenerationBatch {
  id: string;
  project_id: string;
  status: BatchStatus;
  total_combinations: number;
  completed_count: number;
  approved_count: number;
  retry_count: number;
  flagged_count: number;
  error_count: number;
  inngest_run_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  estimated_cost_usd: number | null;
}

export interface GenerationJob {
  id: string;
  batch_id: string;
  hero_shot_id: string;
  swatch_id: string;
  status: JobStatus;
  attempt: number;
  prompt_text: string | null;
  prompt_metadata: Record<string, unknown> | null;
  output_storage_path: string | null;
  generation_time_ms: number | null;
  gemini_model_used: string | null;
  qa_score: number | null;
  qa_detail: QADetail | null;
  qa_feedback: string | null;
  prompt_adjustment: string | null;
  error_message: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface QADetail {
  product_fidelity: number;
  color_accuracy: number;
  composition_match: number;
  visual_quality: number;
  resolution: number;
  aspect_ratio: number;
  ml_compliance: number;
  hero_contamination: number;  // 0=clean, 1=identical to hero. Independent escalation trigger (NOT in weighted score)
}

export interface CategoryTemplate {
  id: string;
  category_key: string;
  template_data: {
    ambientes_lifestyle: string[];
    lighting: string;
    props: string[];
    acciones_producto: string[];
    material_detail: string;
    infografia_features: string[];
  };
  updated_at: string;
}

// Extended types with relations
export interface ProjectWithCounts extends Project {
  hero_count: number;
  swatch_count: number;
  last_batch_status: BatchStatus | null;
  last_approval_rate: number | null;
}

export interface GenerationJobWithRelations extends GenerationJob {
  hero_shot: HeroShot;
  swatch: Swatch;
}

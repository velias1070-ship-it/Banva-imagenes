-- ============================================================
-- Migration 002: Add total_api_calls to generation_jobs
-- Tracks total Gemini API calls per job (generation + QA)
-- ============================================================

ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS total_api_calls INTEGER DEFAULT 0;

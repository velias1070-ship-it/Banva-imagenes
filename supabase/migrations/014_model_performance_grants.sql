-- Migration 014: grant SELECT on model_performance materialized view
-- Sprint 4 follow-up. The MV from migration 010 was created without
-- explicit grants; /admin/performance hit "permission denied for
-- materialized view model_performance" until SELECT was granted to
-- service_role. Vicente applied the GRANTs manually in prod
-- (2026-04-29) — this migration versions the fix.
--
-- Same pattern as migration 013 for golden_runs. Future MV/table
-- migrations should bundle GRANTs in the same file to avoid the
-- "created but not readable" gap.

GRANT SELECT ON TABLE model_performance TO service_role;
GRANT SELECT ON TABLE model_performance TO authenticated;
GRANT SELECT ON TABLE model_performance TO anon;

DO $$
BEGIN
  RAISE NOTICE '[014] model_performance grants applied (already done manually in prod 2026-04-29; this versions it)';
END $$;

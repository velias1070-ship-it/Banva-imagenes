-- Migration 013: grant access to golden_runs
-- Sprint 3 follow-up. Migration 012 created the table but service_role
-- got "permission denied" on the smoke-test insert. This grants what
-- the CLI runner (writes via service role key) and the comparator
-- (reads via service role key) need.

GRANT ALL ON TABLE golden_runs TO service_role;
GRANT ALL ON TABLE golden_runs TO authenticated;
GRANT SELECT ON TABLE golden_runs TO anon;

ALTER TABLE golden_runs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, but we still declare an explicit policy so
-- a future read from the dashboard authenticated session works without
-- a second migration.
DROP POLICY IF EXISTS golden_runs_service_role_all ON golden_runs;
CREATE POLICY golden_runs_service_role_all ON golden_runs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS golden_runs_authenticated_read ON golden_runs;
CREATE POLICY golden_runs_authenticated_read ON golden_runs
  FOR SELECT TO authenticated
  USING (true);

DO $$
BEGIN
  RAISE NOTICE '[013] golden_runs grants applied';
END $$;

CREATE TABLE IF NOT EXISTS policy_test_scenarios (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  intercept_path TEXT NOT NULL,
  payload JSONB NOT NULL,
  expected_outcome TEXT NOT NULL CHECK (expected_outcome IN ('allow', 'deny')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_observed_outcome TEXT CHECK (last_observed_outcome IN ('allow', 'deny', 'error')),
  last_passed BOOLEAN,
  last_error TEXT,
  UNIQUE (tenant_id, policy_id, name)
);

CREATE INDEX IF NOT EXISTS idx_policy_test_scenarios_tenant_policy
  ON policy_test_scenarios(tenant_id, policy_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS capability_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  workload_id TEXT,
  server_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  tool_names JSONB NOT NULL DEFAULT '[]'::JSONB,
  max_amount_cents BIGINT,
  may_delegate BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capability_grants_tenant_subject_created
  ON capability_grants(tenant_id, subject, created_at DESC);

-- Keep development databases that applied an early version of this migration
-- compatible with workload-bound capability grants.
ALTER TABLE capability_grants
  ADD COLUMN IF NOT EXISTS workload_id TEXT;

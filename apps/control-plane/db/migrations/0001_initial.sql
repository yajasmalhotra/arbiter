CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'approver', 'admin')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  rollout_state TEXT NOT NULL CHECK (rollout_state IN ('draft', 'shadow', 'canary', 'enforced', 'rolled_back')),
  rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_ids JSONB NOT NULL,
  policy_versions JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS data_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  data JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_revision_id TEXT NOT NULL REFERENCES policy_revisions(id) ON DELETE RESTRICT,
  data_revision_id TEXT NOT NULL REFERENCES data_revisions(id) ON DELETE RESTRICT,
  rollout_state TEXT NOT NULL CHECK (rollout_state IN ('draft', 'shadow', 'canary', 'enforced', 'rolled_back')),
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'active', 'rolled_back')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_channels (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  channel TEXT NOT NULL CHECK (channel IN ('dev', 'staging', 'prod')),
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, channel)
);

CREATE TABLE IF NOT EXISTS bundle_activations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('dev', 'staging', 'prod')),
  state TEXT NOT NULL CHECK (state IN ('active', 'rolled_back')),
  activated_by TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  requested_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  policy_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_updated_at ON policies(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bundles_tenant_created_at ON bundles(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bundle_activations_tenant_channel_time ON bundle_activations(tenant_id, channel, activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time ON audit_events(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_service_tokens_tenant_name ON service_tokens(tenant_id, name);

CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('HS256')),
  secret TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signing_keys_tenant_key_id ON signing_keys(tenant_id, key_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signing_keys_tenant_active
  ON signing_keys(tenant_id)
  WHERE is_active = TRUE AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_signing_keys_tenant_created_at ON signing_keys(tenant_id, created_at DESC);

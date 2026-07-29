-- Runtime enforcement telemetry is intentionally separate from the
-- tamper-evident control-plane governance chain in audit_events.
CREATE TABLE IF NOT EXISTS runtime_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  policy_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_runtime_audit_events_tenant_time
  ON runtime_audit_events(tenant_id, at DESC, id DESC);

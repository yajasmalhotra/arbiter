ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS previous_hash TEXT,
  ADD COLUMN IF NOT EXISTS event_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_tenant_event_hash
  ON audit_events(tenant_id, event_hash)
  WHERE event_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_chain
  ON audit_events(tenant_id, at ASC, id ASC)
  WHERE event_hash IS NOT NULL;

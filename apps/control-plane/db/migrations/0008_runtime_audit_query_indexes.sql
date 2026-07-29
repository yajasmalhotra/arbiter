CREATE INDEX IF NOT EXISTS idx_runtime_audit_events_tenant_outcome_time
  ON runtime_audit_events(tenant_id, (metadata->>'allow'), at DESC, id DESC)
  WHERE action = 'intercept_decision';

CREATE INDEX IF NOT EXISTS idx_runtime_audit_events_tenant_tool_time
  ON runtime_audit_events(tenant_id, (metadata->>'tool_name'), at DESC, id DESC)
  WHERE action = 'intercept_decision';

CREATE INDEX IF NOT EXISTS idx_runtime_audit_events_tenant_decision_id
  ON runtime_audit_events(tenant_id, (metadata->>'decision_id'))
  WHERE action = 'intercept_decision';

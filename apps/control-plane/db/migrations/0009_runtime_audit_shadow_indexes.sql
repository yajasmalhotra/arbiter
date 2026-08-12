CREATE INDEX IF NOT EXISTS idx_runtime_audit_events_tenant_shadow_outcome_time
  ON runtime_audit_events (
    tenant_id,
    (metadata->>'enforcement_mode'),
    (metadata->>'policy_allow'),
    at DESC,
    id DESC
  )
  WHERE action = 'intercept_decision';

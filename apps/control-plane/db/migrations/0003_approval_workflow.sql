ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS action TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS review_notes TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

UPDATE approval_requests
SET action = COALESCE(action, 'promote_bundle'),
    channel = COALESCE(channel, 'prod')
WHERE action IS NULL OR channel IS NULL;

ALTER TABLE approval_requests
  ALTER COLUMN action SET DEFAULT 'promote_bundle',
  ALTER COLUMN action SET NOT NULL,
  ALTER COLUMN channel SET DEFAULT 'prod',
  ALTER COLUMN channel SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'approval_requests_action_check'
  ) THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_action_check
      CHECK (action IN ('promote_bundle', 'rollback_channel'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'approval_requests_channel_check'
  ) THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_channel_check
      CHECK (channel IN ('dev', 'staging', 'prod'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_state_created
  ON approval_requests(tenant_id, state, created_at DESC);

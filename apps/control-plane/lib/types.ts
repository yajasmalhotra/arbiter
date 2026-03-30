export type RolloutState = "draft" | "shadow" | "canary" | "enforced" | "rolled_back";

export type PolicyRecord = {
  id: string;
  name: string;
  packageName: string;
  version: string;
  rolloutState: RolloutState;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  policyId?: string;
  at: string;
  metadata?: Record<string, unknown>;
};

export type ControlPlaneData = {
  policies: PolicyRecord[];
  auditEvents: AuditEvent[];
};

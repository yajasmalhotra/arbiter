export type RolloutState = "draft" | "shadow" | "canary" | "enforced" | "rolled_back";
export type BundleStatus = "draft" | "published" | "active" | "rolled_back";
export type ApprovalAction = "promote_bundle" | "rollback_channel";
export type ApprovalState = "pending" | "approved" | "rejected";

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
  previousHash?: string;
  eventHash?: string;
};

export type AuditIntegrityReport = {
  verified: boolean;
  checkedEvents: number;
  unsealedLegacyEvents: number;
  latestHash?: string;
  failure?: string;
};

export type RuntimeDecisionEvent = {
  id: string;
  at: string;
  decisionId?: string;
  requestId?: string;
  traceId?: string;
  toolName?: string;
  allowed?: boolean;
  policyAllowed?: boolean;
  enforcementMode?: string;
  reason?: string;
  policyPackage?: string;
  policyVersion?: string;
  dataRevision?: string;
  latencyMs?: number;
};

export type RuntimeDecisionSummary = {
  windowHours: number;
  total: number;
  allowed: number;
  denied: number;
  shadowDenied: number;
  recorded: number;
  denialRate: number;
  policyDenialRate: number;
  topDeniedTools: Array<{ toolName: string; count: number }>;
};

export type PolicyTestScenario = {
  id: string;
  policyId: string;
  name: string;
  interceptPath: string;
  payload: unknown;
  expectedOutcome: "allow" | "deny";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastObservedOutcome?: "allow" | "deny" | "error";
  lastPassed?: boolean;
  lastError?: string;
};

export type PolicyRevision = {
  id: string;
  policyIds: string[];
  policyVersions: Record<string, string>;
  createdBy: string;
  createdAt: string;
};

export type DataRevision = {
  id: string;
  data: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
};

export type BundleSnapshot = {
  policies: PolicyRecord[];
  data: Record<string, unknown>;
};

export type BundleArtifact = {
  id: string;
  policyRevisionId: string;
  dataRevisionId: string;
  rolloutState: RolloutState;
  digest: string;
  status: BundleStatus;
  createdBy: string;
  createdAt: string;
  snapshot: BundleSnapshot;
};

export type BundleActivation = {
  id: string;
  bundleId: string;
  channel: "dev" | "staging" | "prod";
  state: "active" | "rolled_back";
  activatedBy: string;
  activatedAt: string;
  notes?: string;
};

export type BundleChannel = {
  channel: "dev" | "staging" | "prod";
  bundleId: string;
  digest: string;
  policyRevisionId: string;
  dataRevisionId: string;
  rolloutState: RolloutState;
  enforcementMode: "enforce" | "shadow";
};

export type ApprovalRequest = {
  id: string;
  bundleId: string;
  action: ApprovalAction;
  channel: "dev" | "staging" | "prod";
  state: ApprovalState;
  requestedBy: string;
  reviewedBy?: string;
  notes?: string;
  reviewNotes?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
};

export type ServiceToken = {
  id: string;
  name: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type SigningKey = {
  id: string;
  name: string;
  keyId: string;
  scope: string;
  algorithm: "HS256" | "RS256";
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  revokedAt?: string;
};

export type CapabilityGrant = {
  id: string;
  name: string;
  subject: string;
  workloadId?: string;
  serverIds: string[];
  toolNames: string[];
  maxAmountCents?: number;
  mayDelegate: boolean;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
};

export type ControlPlaneData = {
  policies: PolicyRecord[];
  policyTestScenarios: PolicyTestScenario[];
  auditEvents: AuditEvent[];
  policyRevisions: PolicyRevision[];
  dataRevisions: DataRevision[];
  bundles: BundleArtifact[];
  bundleActivations: BundleActivation[];
  approvalRequests: ApprovalRequest[];
};

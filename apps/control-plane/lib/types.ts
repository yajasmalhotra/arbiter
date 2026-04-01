export type RolloutState = "draft" | "shadow" | "canary" | "enforced" | "rolled_back";
export type BundleStatus = "draft" | "published" | "active" | "rolled_back";

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
  algorithm: "HS256";
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  revokedAt?: string;
};

export type ControlPlaneData = {
  policies: PolicyRecord[];
  auditEvents: AuditEvent[];
  policyRevisions: PolicyRevision[];
  dataRevisions: DataRevision[];
  bundles: BundleArtifact[];
  bundleActivations: BundleActivation[];
};

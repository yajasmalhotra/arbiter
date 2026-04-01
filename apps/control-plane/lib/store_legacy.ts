import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import type {
  ApprovalAction,
  ApprovalRequest,
  ApprovalState,
  AuditEvent,
  BundleActivation,
  BundleArtifact,
  BundleSnapshot,
  ControlPlaneData,
  DataRevision,
  PolicyRecord,
  PolicyRevision,
  RolloutState
} from "./types";

type BundleChannelName = "dev" | "staging" | "prod";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "control-plane.json");

const initialData: ControlPlaneData = {
  policies: [],
  auditEvents: [],
  policyRevisions: [],
  dataRevisions: [],
  bundles: [],
  bundleActivations: [],
  approvalRequests: []
};

function normalizeData(data: Partial<ControlPlaneData> | undefined): ControlPlaneData {
  return {
    policies: data?.policies ?? [],
    auditEvents: data?.auditEvents ?? [],
    policyRevisions: data?.policyRevisions ?? [],
    dataRevisions: data?.dataRevisions ?? [],
    bundles: data?.bundles ?? [],
    bundleActivations: data?.bundleActivations ?? [],
    approvalRequests: data?.approvalRequests ?? []
  };
}

async function readData(): Promise<ControlPlaneData> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return normalizeData(JSON.parse(raw) as Partial<ControlPlaneData>);
  } catch {
    return normalizeData(initialData);
  }
}

async function writeData(data: ControlPlaneData): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function listPolicies(): Promise<PolicyRecord[]> {
  const data = await readData();
  return data.policies.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPolicy(id: string): Promise<PolicyRecord | undefined> {
  const data = await readData();
  return data.policies.find((policy) => policy.id === id);
}

export async function upsertPolicy(input: Omit<PolicyRecord, "createdAt" | "updatedAt">): Promise<PolicyRecord> {
  const data = await readData();
  const now = new Date().toISOString();
  const existing = data.policies.find((policy) => policy.id === input.id);

  if (existing) {
    existing.name = input.name;
    existing.packageName = input.packageName;
    existing.version = input.version;
    existing.rolloutState = input.rolloutState;
    existing.rules = input.rules;
    existing.updatedAt = now;
    await writeData(data);
    await appendAuditEvent({
      action: "policy_updated",
      actor: "control-plane",
      policyId: existing.id,
      metadata: { rolloutState: existing.rolloutState }
    });
    return existing;
  }

  const created: PolicyRecord = {
    ...input,
    createdAt: now,
    updatedAt: now
  };
  data.policies.push(created);
  await writeData(data);
  await appendAuditEvent({
    action: "policy_created",
    actor: "control-plane",
    policyId: created.id,
    metadata: { rolloutState: created.rolloutState }
  });
  return created;
}

export async function deletePolicy(id: string): Promise<boolean> {
  const data = await readData();
  const before = data.policies.length;
  data.policies = data.policies.filter((policy) => policy.id !== id);
  if (data.policies.length == before) {
    return false;
  }
  await writeData(data);
  await appendAuditEvent({
    action: "policy_deleted",
    actor: "control-plane",
    policyId: id
  });
  return true;
}

export async function setRolloutState(id: string, rolloutState: RolloutState): Promise<PolicyRecord | undefined> {
  const data = await readData();
  const policy = data.policies.find((item) => item.id === id);
  if (!policy) {
    return undefined;
  }

  policy.rolloutState = rolloutState;
  policy.updatedAt = new Date().toISOString();
  await writeData(data);
  await appendAuditEvent({
    action: "rollout_state_changed",
    actor: "control-plane",
    policyId: id,
    metadata: { rolloutState }
  });
  return policy;
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const data = await readData();
  return data.auditEvents.sort((a, b) => b.at.localeCompare(a.at));
}

export async function appendAuditEvent(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  const data = await readData();
  const created: AuditEvent = {
    ...event,
    id: crypto.randomUUID(),
    at: new Date().toISOString()
  };
  data.auditEvents.push(created);
  await writeData(data);
  return created;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function bundleDigest(snapshot: BundleSnapshot): string {
  return crypto.createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

type PublishBundleInput = {
  policyIds?: string[];
  data?: Record<string, unknown>;
  rolloutState?: RolloutState;
  actor?: string;
};

export async function listBundles(): Promise<BundleArtifact[]> {
  const data = await readData();
  return data.bundles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBundle(id: string): Promise<BundleArtifact | undefined> {
  const data = await readData();
  return data.bundles.find((bundle) => bundle.id === id);
}

export async function getActiveBundle(): Promise<BundleArtifact | undefined> {
  const data = await readData();
  return data.bundles.find((bundle) => bundle.status === "active");
}

export async function listPolicyRevisions(): Promise<PolicyRevision[]> {
  const data = await readData();
  return data.policyRevisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listDataRevisions(): Promise<DataRevision[]> {
  const data = await readData();
  return data.dataRevisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listBundleActivations(): Promise<BundleActivation[]> {
  const data = await readData();
  return data.bundleActivations
    .map((activation) => ({
      ...activation,
      channel: activation.channel ?? "prod"
    }))
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
}

export async function listApprovalRequests(state?: ApprovalState): Promise<ApprovalRequest[]> {
  const data = await readData();
  const requests = state
    ? data.approvalRequests.filter((request) => request.state === state)
    : data.approvalRequests;
  return requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type CreateApprovalRequestInput = {
  action: ApprovalAction;
  bundleId?: string;
  channel: BundleChannelName;
  actor?: string;
  notes?: string;
};

function currentBundleForChannel(
  data: ControlPlaneData,
  channel: BundleChannelName
): BundleArtifact | undefined {
  for (const activation of data.bundleActivations
    .filter((item) => item.channel === channel && item.state === "active")
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))) {
    const bundle = data.bundles.find((item) => item.id === activation.bundleId);
    if (bundle) {
      return bundle;
    }
  }
  return data.bundles.find((bundle) => bundle.status === "active");
}

export async function createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
  const data = await readData();
  const actor = input.actor?.trim() || "control-plane";
  const now = new Date().toISOString();
  const channel = input.channel;
  let bundleId = input.bundleId?.trim() ?? "";
  if (input.action === "rollback_channel") {
    const current = currentBundleForChannel(data, channel);
    if (!current) {
      throw new Error(`no active bundle found for ${channel}`);
    }
    bundleId = current.id;
  }
  if (!bundleId) {
    throw new Error("bundle id is required");
  }
  const bundle = data.bundles.find((item) => item.id === bundleId);
  if (!bundle) {
    throw new Error("bundle not found");
  }

  const existing = data.approvalRequests.find(
    (request) =>
      request.state === "pending" &&
      request.action === input.action &&
      request.channel === channel &&
      request.bundleId === bundleId
  );
  if (existing) {
    return existing;
  }

  const created: ApprovalRequest = {
    id: `ar_${crypto.randomUUID()}`,
    bundleId,
    action: input.action,
    channel,
    state: "pending",
    requestedBy: actor,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  };
  data.approvalRequests.push(created);
  await writeData(data);
  await appendAuditEvent({
    action: "approval_requested",
    actor,
    metadata: {
      approvalRequestId: created.id,
      action: created.action,
      channel: created.channel,
      bundleId: created.bundleId,
      notes: created.notes ?? ""
    }
  });
  return created;
}

export async function publishBundle(input: PublishBundleInput = {}): Promise<BundleArtifact> {
  const data = await readData();
  const now = new Date().toISOString();
  const actor = input.actor?.trim() || "control-plane";

  const selectedPolicies = (input.policyIds?.length
    ? data.policies.filter((policy) => input.policyIds?.includes(policy.id))
    : data.policies
  ).map((policy) => ({ ...policy }));

  const policyRevision: PolicyRevision = {
    id: `pr_${crypto.randomUUID()}`,
    policyIds: selectedPolicies.map((policy) => policy.id),
    policyVersions: Object.fromEntries(selectedPolicies.map((policy) => [policy.id, policy.version])),
    createdBy: actor,
    createdAt: now
  };
  data.policyRevisions.push(policyRevision);

  const dataRevision: DataRevision = {
    id: `dr_${crypto.randomUUID()}`,
    data: input.data ?? {},
    createdBy: actor,
    createdAt: now
  };
  data.dataRevisions.push(dataRevision);

  const snapshot: BundleSnapshot = {
    policies: selectedPolicies,
    data: dataRevision.data
  };
  const bundle: BundleArtifact = {
    id: `bundle_${crypto.randomUUID()}`,
    policyRevisionId: policyRevision.id,
    dataRevisionId: dataRevision.id,
    rolloutState: input.rolloutState ?? "draft",
    digest: bundleDigest(snapshot),
    status: "published",
    createdBy: actor,
    createdAt: now,
    snapshot
  };
  data.bundles.push(bundle);

  await writeData(data);
  await appendAuditEvent({
    action: "bundle_published",
    actor,
    metadata: {
      bundleId: bundle.id,
      digest: bundle.digest,
      policyRevisionId: bundle.policyRevisionId,
      dataRevisionId: bundle.dataRevisionId,
      rolloutState: bundle.rolloutState
    }
  });

  return bundle;
}

type ActivateBundleInput = {
  actor?: string;
  notes?: string;
};

export async function activateBundle(id: string, input: ActivateBundleInput = {}): Promise<BundleArtifact | undefined> {
  const data = await readData();
  const actor = input.actor?.trim() || "control-plane";
  const now = new Date().toISOString();

  const target = data.bundles.find((bundle) => bundle.id === id);
  if (!target) {
    return undefined;
  }

  for (const bundle of data.bundles) {
    if (bundle.status === "active" && bundle.id !== id) {
      bundle.status = "rolled_back";
      data.bundleActivations.push({
        id: `ba_${crypto.randomUUID()}`,
        bundleId: bundle.id,
        channel: "prod",
        state: "rolled_back",
        activatedBy: actor,
        activatedAt: now,
        notes: `superseded by ${id}`
      });
    }
  }

  target.status = "active";
  if (target.rolloutState !== "rolled_back") {
    target.rolloutState = "enforced";
  }
  data.bundleActivations.push({
    id: `ba_${crypto.randomUUID()}`,
    bundleId: id,
    channel: "prod",
    state: "active",
    activatedBy: actor,
    activatedAt: now,
    notes: input.notes
  });

  await writeData(data);
  await appendAuditEvent({
    action: "bundle_activated",
    actor,
    metadata: {
      bundleId: id,
      notes: input.notes ?? ""
    }
  });
  return target;
}

export async function rollbackChannel(
  channel: BundleChannelName,
  input: ActivateBundleInput = {}
): Promise<BundleArtifact | undefined> {
  const data = await readData();
  const actor = input.actor?.trim() || "control-plane";
  const now = new Date().toISOString();

  const currentActivation = data.bundleActivations
    .filter((activation) => activation.channel === channel && activation.state === "active")
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0];
  if (!currentActivation) {
    return undefined;
  }

  const previousActivation = data.bundleActivations
    .filter(
      (activation) =>
        activation.channel === channel &&
        activation.state === "active" &&
        activation.bundleId !== currentActivation.bundleId
    )
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0];
  if (!previousActivation) {
    return undefined;
  }

  const currentBundle = data.bundles.find((bundle) => bundle.id === currentActivation.bundleId);
  const previousBundle = data.bundles.find((bundle) => bundle.id === previousActivation.bundleId);
  if (!currentBundle || !previousBundle) {
    return undefined;
  }

  currentBundle.status = "rolled_back";
  previousBundle.status = "active";
  if (previousBundle.rolloutState !== "rolled_back") {
    previousBundle.rolloutState = "enforced";
  }

  data.bundleActivations.push({
    id: `ba_${crypto.randomUUID()}`,
    bundleId: currentBundle.id,
    channel,
    state: "rolled_back",
    activatedBy: actor,
    activatedAt: now,
    notes: input.notes ?? "manual rollback"
  });
  data.bundleActivations.push({
    id: `ba_${crypto.randomUUID()}`,
    bundleId: previousBundle.id,
    channel,
    state: "active",
    activatedBy: actor,
    activatedAt: now,
    notes: input.notes ?? "rollback restore"
  });

  await writeData(data);
  await appendAuditEvent({
    action: "bundle_rolled_back",
    actor,
    metadata: {
      channel,
      restoredBundleId: previousBundle.id,
      notes: input.notes ?? ""
    }
  });
  return previousBundle;
}

type ReviewApprovalRequestInput = {
  actor?: string;
  notes?: string;
};

export async function approveApprovalRequest(
  id: string,
  input: ReviewApprovalRequestInput = {}
): Promise<{ approvalRequest: ApprovalRequest; bundle?: BundleArtifact } | undefined> {
  const data = await readData();
  const actor = input.actor?.trim() || "control-plane";
  const request = data.approvalRequests.find((item) => item.id === id);
  if (!request || request.state !== "pending") {
    return undefined;
  }

  let bundle: BundleArtifact | undefined;
  if (request.action === "promote_bundle") {
    bundle = await activateBundle(request.bundleId, {
      actor,
      notes: input.notes?.trim() || request.notes
    });
    if (!bundle) {
      throw new Error("bundle not found");
    }
  } else {
    bundle = await rollbackChannel(request.channel, {
      actor,
      notes: input.notes?.trim() || request.notes
    });
    if (!bundle) {
      throw new Error(`no previous bundle found for channel ${request.channel}`);
    }
  }

  const now = new Date().toISOString();
  const next = await readData();
  const updated = next.approvalRequests.find((item) => item.id === id);
  if (!updated || updated.state !== "pending") {
    throw new Error("approval request is no longer pending");
  }
  updated.state = "approved";
  updated.reviewedBy = actor;
  updated.reviewedAt = now;
  updated.reviewNotes = input.notes?.trim() || undefined;
  updated.updatedAt = now;
  await writeData(next);

  await appendAuditEvent({
    action: "approval_approved",
    actor,
    metadata: {
      approvalRequestId: updated.id,
      action: updated.action,
      channel: updated.channel,
      bundleId: updated.bundleId,
      notes: updated.reviewNotes ?? ""
    }
  });

  return {
    approvalRequest: updated,
    bundle
  };
}

export async function rejectApprovalRequest(
  id: string,
  input: ReviewApprovalRequestInput = {}
): Promise<ApprovalRequest | undefined> {
  const data = await readData();
  const actor = input.actor?.trim() || "control-plane";
  const request = data.approvalRequests.find((item) => item.id === id);
  if (!request || request.state !== "pending") {
    return undefined;
  }
  const now = new Date().toISOString();
  request.state = "rejected";
  request.reviewedBy = actor;
  request.reviewedAt = now;
  request.reviewNotes = input.notes?.trim() || undefined;
  request.updatedAt = now;
  await writeData(data);

  await appendAuditEvent({
    action: "approval_rejected",
    actor,
    metadata: {
      approvalRequestId: request.id,
      action: request.action,
      channel: request.channel,
      bundleId: request.bundleId,
      notes: request.reviewNotes ?? ""
    }
  });
  return request;
}

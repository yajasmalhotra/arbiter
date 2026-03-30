import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import type { AuditEvent, ControlPlaneData, PolicyRecord, RolloutState } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "control-plane.json");

const initialData: ControlPlaneData = {
  policies: [],
  auditEvents: []
};

async function readData(): Promise<ControlPlaneData> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return JSON.parse(raw) as ControlPlaneData;
  } catch {
    return initialData;
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

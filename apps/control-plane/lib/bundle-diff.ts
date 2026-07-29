import type { BundleArtifact, PolicyRecord } from "./types";

export type BundleChangeSummary = {
  baselineAvailable: boolean;
  policies: { added: string[]; removed: string[]; changed: string[] };
  data: { added: string[]; removed: string[]; changed: string[] };
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function changedPolicy(left: PolicyRecord, right: PolicyRecord): boolean {
  return left.packageName !== right.packageName || left.version !== right.version || left.rolloutState !== right.rolloutState || stableStringify(left.rules) !== stableStringify(right.rules);
}

function changeKeys(before: Record<string, unknown>, after: Record<string, unknown>) {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(after).sort()) {
    if (!(key in before)) added.push(key);
    else if (stableStringify(before[key]) !== stableStringify(after[key])) changed.push(key);
  }
  for (const key of Object.keys(before).sort()) {
    if (!(key in after)) removed.push(key);
  }
  return { added, removed, changed };
}

export function summarizeBundleChanges(baseline: BundleArtifact | undefined, candidate: BundleArtifact | undefined): BundleChangeSummary | undefined {
  if (!candidate) return undefined;
  if (!baseline) {
    return {
      baselineAvailable: false,
      policies: { added: candidate.snapshot.policies.map((policy) => policy.name), removed: [], changed: [] },
      data: { added: Object.keys(candidate.snapshot.data).sort(), removed: [], changed: [] }
    };
  }
  const currentPolicies = new Map(baseline.snapshot.policies.map((policy) => [policy.id, policy]));
  const nextPolicies = new Map(candidate.snapshot.policies.map((policy) => [policy.id, policy]));
  const policies = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  for (const [id, policy] of nextPolicies) {
    const current = currentPolicies.get(id);
    if (!current) policies.added.push(policy.name);
    else if (changedPolicy(current, policy)) policies.changed.push(policy.name);
  }
  for (const [id, policy] of currentPolicies) {
    if (!nextPolicies.has(id)) policies.removed.push(policy.name);
  }
  policies.added.sort();
  policies.removed.sort();
  policies.changed.sort();
  return { baselineAvailable: true, policies, data: changeKeys(baseline.snapshot.data, candidate.snapshot.data) };
}

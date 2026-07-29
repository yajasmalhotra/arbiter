import { describe, expect, it } from "vitest";

import { summarizeBundleChanges } from "./bundle-diff";
import type { BundleArtifact } from "./types";

function bundle(id: string, policies: BundleArtifact["snapshot"]["policies"], data: Record<string, unknown>): BundleArtifact {
  return {
    id,
    policyRevisionId: `${id}-policy`,
    dataRevisionId: `${id}-data`,
    rolloutState: "enforced",
    digest: id,
    status: "published",
    createdBy: "test",
    createdAt: "2026-07-28T00:00:00.000Z",
    snapshot: { policies, data }
  };
}

const policy = (id: string, name: string, version: string) => ({
  id,
  name,
  packageName: `arbiter.${id}`,
  version,
  rolloutState: "enforced" as const,
  rules: { allow: version === "v2" },
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z"
});

describe("bundle release preview", () => {
  it("summarizes policy and top-level data changes before promotion", () => {
    const summary = summarizeBundleChanges(
      bundle("current", [policy("payments", "Payments", "v1"), policy("legacy", "Legacy", "v1")], { limits: { refunds: 100 }, regions: ["us"] }),
      bundle("candidate", [policy("payments", "Payments", "v2"), policy("notifications", "Notifications", "v1")], { limits: { refunds: 50 }, features: { approvals: true } })
    );
    expect(summary).toEqual({
      baselineAvailable: true,
      policies: { added: ["Notifications"], removed: ["Legacy"], changed: ["Payments"] },
      data: { added: ["features"], removed: ["regions"], changed: ["limits"] }
    });
  });

  it("marks a first release when no production baseline exists", () => {
    const summary = summarizeBundleChanges(undefined, bundle("candidate", [policy("payments", "Payments", "v1")], { limits: {} }));
    expect(summary).toMatchObject({ baselineAvailable: false, policies: { added: ["Payments"] }, data: { added: ["limits"] } });
  });
});

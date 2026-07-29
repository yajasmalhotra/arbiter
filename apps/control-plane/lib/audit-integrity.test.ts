import { describe, expect, it } from "vitest";

import { auditEventHash, verifyAuditChain } from "./store";

function event(id: string, previousHash?: string) {
  const value = {
    id,
    action: "policy_updated",
    actor: "alice",
    policyId: "policy-1",
    at: `2026-07-28T00:00:0${id}.000Z`,
    metadata: { rolloutState: "enforced" },
    previousHash
  };
  return { ...value, eventHash: auditEventHash("tenant-a", value) };
}

describe("tamper-evident audit chain", () => {
  it("verifies a tenant-scoped sequence and detects changed payloads", () => {
    const first = event("1");
    const second = event("2", first.eventHash);
    expect(verifyAuditChain("tenant-a", [first, second])).toMatchObject({ verified: true, checkedEvents: 2, latestHash: second.eventHash });

    const modified = { ...second, actor: "mallory" };
    expect(verifyAuditChain("tenant-a", [first, modified])).toMatchObject({ verified: false, failure: "event hash mismatch at 2" });
  });

  it("detects removal or reordering through the previous-hash link", () => {
    const first = event("1");
    const second = event("2", first.eventHash);
    expect(verifyAuditChain("tenant-a", [second])).toMatchObject({ verified: false, failure: "chain link mismatch at 2" });
    expect(verifyAuditChain("tenant-b", [first, second])).toMatchObject({ verified: false, failure: "event hash mismatch at 1" });
  });
});

import { describe, expect, it } from "vitest";

import { classifyPolicyTestOutcome, policyTestAssertion } from "./policy-validation";

describe("policy validation outcomes", () => {
  it("prefers the signed decision body over transport status", () => {
    expect(classifyPolicyTestOutcome(200, { decision: { allow: false } })).toBe("deny");
    expect(classifyPolicyTestOutcome(403, { decision: { allow: true } })).toBe("allow");
  });

  it("distinguishes policy denials from operational errors", () => {
    expect(classifyPolicyTestOutcome(403, {})).toBe("deny");
    expect(classifyPolicyTestOutcome(503, { error: "OPA unavailable" })).toBe("error");
    expect(policyTestAssertion("deny", "deny")).toEqual({ expected: "deny", observed: "deny", passed: true });
    expect(policyTestAssertion("allow", "error")).toEqual({
      expected: "allow",
      observed: "error",
      passed: false
    });
  });
});

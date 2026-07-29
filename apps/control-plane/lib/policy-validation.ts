export type PolicyTestOutcome = "allow" | "deny" | "error";
export type PolicyTestExpectation = "allow" | "deny";

export type PolicyTestAssertion = {
  expected: PolicyTestExpectation;
  observed: PolicyTestOutcome;
  passed: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function classifyPolicyTestOutcome(status: number, response: unknown): PolicyTestOutcome {
  const decision = asRecord(asRecord(response).decision);
  if (typeof decision.allow === "boolean") return decision.allow ? "allow" : "deny";
  if (status === 403) return "deny";
  if (status >= 200 && status < 300) return "allow";
  return "error";
}

export function policyTestAssertion(
  expected: PolicyTestExpectation | undefined,
  observed: PolicyTestOutcome
): PolicyTestAssertion | undefined {
  return expected ? { expected, observed, passed: expected === observed } : undefined;
}

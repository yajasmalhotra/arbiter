export type PolicyTestOutcome = "allow" | "deny" | "error";
export type PolicyTestExpectation = "allow" | "deny";

export const POLICY_TEST_INTERCEPT_PATHS = [
  "/v1/intercept/openai",
  "/v1/intercept/openai/stream",
  "/v1/intercept/anthropic",
  "/v1/intercept/framework/generic",
  "/v1/intercept/framework/langchain"
] as const;

export const MAX_POLICY_TEST_SCENARIOS = 50;
export const MAX_POLICY_TEST_PAYLOAD_BYTES = 128 * 1024;

export type PolicyTestAssertion = {
  expected: PolicyTestExpectation;
  observed: PolicyTestOutcome;
  passed: boolean;
};

export type PolicyValidationExecution = {
  url: string;
  durationMs: number;
  status?: number;
  response?: unknown;
  observedOutcome: PolicyTestOutcome;
  assertion?: PolicyTestAssertion;
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isPolicyTestInterceptPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (POLICY_TEST_INTERCEPT_PATHS as readonly string[]).includes(value)
  );
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

function policyTestTimeoutMs(): number {
  const parsed = Number(process.env.ARBITER_POLICY_TEST_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(parsed) ? Math.min(60_000, Math.max(1_000, parsed)) : 10_000;
}

function authorizationHeader(): string | undefined {
  const token = process.env.ARBITER_POLICY_TEST_BEARER_TOKEN?.trim();
  if (!token) return undefined;
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

export function configuredPolicyTestBaseUrl(): string {
  const raw = process.env.ARBITER_URL?.trim() || "http://127.0.0.1:8080";
  return raw.replace(/\/$/, "");
}

export async function executePolicyValidation(input: {
  interceptPath: string;
  payload: unknown;
  expectedOutcome?: PolicyTestExpectation;
  baseUrl?: string;
  useServerCredentials?: boolean;
}): Promise<PolicyValidationExecution> {
  const baseUrl = input.baseUrl ?? configuredPolicyTestBaseUrl();
  const url = `${baseUrl}${input.interceptPath}`;
  const started = Date.now();
  const useServerCredentials = input.useServerCredentials ?? input.baseUrl === undefined;
  const gatewayKey = useServerCredentials
    ? process.env.ARBITER_POLICY_TEST_GATEWAY_KEY?.trim()
    : undefined;
  const authorization = useServerCredentials ? authorizationHeader() : undefined;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(gatewayKey ? { "X-Arbiter-Gateway-Key": gatewayKey } : {}),
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: JSON.stringify(input.payload),
      cache: "no-store",
      signal: AbortSignal.timeout(policyTestTimeoutMs())
    });
    const text = await upstream.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const observedOutcome = classifyPolicyTestOutcome(upstream.status, parsed);
    return {
      url,
      durationMs: Date.now() - started,
      status: upstream.status,
      response: parsed,
      observedOutcome,
      assertion: policyTestAssertion(input.expectedOutcome, observedOutcome)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return {
      url,
      durationMs: Date.now() - started,
      observedOutcome: "error",
      assertion: policyTestAssertion(input.expectedOutcome, "error"),
      error: message
    };
  }
}

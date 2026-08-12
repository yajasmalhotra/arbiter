import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyPolicyTestOutcome,
  executePolicyValidation,
  isPolicyTestInterceptPath,
  policyTestAssertion
} from "./policy-validation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("policy validation outcomes", () => {
  it("prefers the signed decision body over transport status", () => {
    expect(classifyPolicyTestOutcome(200, { decision: { allow: false } })).toBe("deny");
    expect(classifyPolicyTestOutcome(403, { decision: { allow: true } })).toBe("allow");
  });

  it("uses the raw policy verdict for shadow-mode regression assertions", () => {
    expect(classifyPolicyTestOutcome(200, {
      decision: { allow: true, policy_allow: false, enforcement_mode: "shadow" }
    })).toBe("deny");
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

  it("only accepts supported interceptor routes", () => {
    expect(isPolicyTestInterceptPath("/v1/intercept/openai")).toBe(true);
    expect(isPolicyTestInterceptPath("http://metadata.internal/")).toBe(false);
  });

  it("sends configured service credentials to the configured interceptor", async () => {
    vi.stubEnv("ARBITER_URL", "https://arbiter.example/");
    vi.stubEnv("ARBITER_POLICY_TEST_GATEWAY_KEY", "gateway-key");
    vi.stubEnv("ARBITER_POLICY_TEST_BEARER_TOKEN", "service-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ decision: { allow: false } }), { status: 403 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const execution = await executePolicyValidation({
      interceptPath: "/v1/intercept/openai",
      payload: { request: "test" },
      expectedOutcome: "deny"
    });

    expect(execution.observedOutcome).toBe("deny");
    expect(execution.assertion?.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://arbiter.example/v1/intercept/openai",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer service-token",
          "X-Arbiter-Gateway-Key": "gateway-key"
        })
      })
    );
  });

  it("does not forward service credentials to an explicit override", async () => {
    vi.stubEnv("ARBITER_POLICY_TEST_GATEWAY_KEY", "gateway-key");
    vi.stubEnv("ARBITER_POLICY_TEST_BEARER_TOKEN", "service-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ decision: { allow: true } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await executePolicyValidation({
      interceptPath: "/v1/intercept/openai",
      payload: {},
      baseUrl: "http://127.0.0.1:9000",
      useServerCredentials: false
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9000/v1/intercept/openai",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" }
      })
    );
  });
});

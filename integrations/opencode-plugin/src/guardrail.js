import { resolveOpenCodeConfig } from "./config.js";
import { postJSON } from "./http.js";

function reason(body) {
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  if (typeof body?.decision?.reason === "string") return body.decision.reason.trim();
  return "";
}

function optionalHeader(value, name) {
  return value ? { [name]: value } : {};
}

function callKey(input) {
  return `${input?.sessionID ?? ""}:${input?.callID ?? ""}`;
}

function canonical(config, input, args) {
  return {
    schema_version: "v1alpha1",
    metadata: {
      request_id: `opencode:${input.sessionID}:${input.callID}`,
      session_id: input.sessionID,
      tenant_id: config.tenantId,
      provider: "opencode"
    },
    agent_context: { actor: { id: config.actorId, type: "agent" } },
    tool_name: input.tool,
    parameters: args ?? {}
  };
}

export function createArbiterOpenCodeGuardrail({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = resolveOpenCodeConfig(env);
  const protectedTools = new Set(config.protectedTools);
  const verifiedCalls = new Map();

  function isProtected(tool) {
    return config.protectAll || protectedTools.has(tool);
  }

  function allowDevelopment(message) {
    if (config.failClosed) throw new Error(message);
    logger.warn?.(`${message}; allowing because ARBITER_OPENCODE_FAIL_CLOSED=false`);
  }

  async function before(input, output) {
    if (!isProtected(input?.tool)) return;
    if (config.missing.length) {
      allowDevelopment(`Arbiter OpenCode plugin misconfigured: missing ${config.missing.join(", ")}`);
      return;
    }

    const request = canonical(config, input, output?.args);
    let intercept;
    try {
      intercept = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/intercept/framework/generic",
        headers: {
          ...optionalHeader(config.gatewayKey, "X-Arbiter-Gateway-Key"),
          ...optionalHeader(config.bearerToken, "Authorization")
        },
        payload: request,
        timeoutMs: config.timeoutMs
      });
    } catch (error) {
      allowDevelopment(`Arbiter intercept failed: ${String(error)}`);
      return;
    }

    const interceptReason = reason(intercept.body);
    if (intercept.status !== 200) {
      if (intercept.status === 403) throw new Error(interceptReason || "Blocked by Arbiter policy");
      allowDevelopment(`Arbiter intercept failed (${intercept.status})${interceptReason ? `: ${interceptReason}` : ""}`);
      return;
    }

    const token = intercept.body?.token;
    if (typeof token !== "string" || !token.trim()) {
      allowDevelopment("Arbiter intercept response missing execution permit");
      return;
    }

    let verification;
    try {
      verification = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/execute/verify/canonical",
        headers: optionalHeader(config.serviceKey, "X-Arbiter-Service-Key"),
        payload: { token, request },
        timeoutMs: config.timeoutMs
      });
    } catch (error) {
      allowDevelopment(`Arbiter permit verification failed: ${String(error)}`);
      return;
    }
    if (verification.status !== 200) {
      const verificationReason = reason(verification.body);
      throw new Error(`Arbiter permit verification denied${verificationReason ? `: ${verificationReason}` : ""}`);
    }
    verifiedCalls.set(callKey(input), Date.now());
    if (verifiedCalls.size > 2048) {
      verifiedCalls.delete(verifiedCalls.keys().next().value);
    }
  }

  async function after(input) {
    if (!verifiedCalls.delete(callKey(input)) || !config.recordState) return;
    try {
      const response = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/state/actions",
        headers: optionalHeader(config.serviceKey, "X-Arbiter-Service-Key"),
        payload: {
          tenant_id: config.tenantId,
          actor_id: config.actorId,
          session_id: input.sessionID,
          tool_name: input.tool,
          outcome: "allowed"
        },
        timeoutMs: config.timeoutMs
      });
      if (response.status !== 200 && response.status !== 202) {
        logger.warn?.(`Arbiter state record returned status=${response.status}`);
      }
    } catch (error) {
      logger.warn?.(`Arbiter state record failed: ${String(error)}`);
    }
  }

  return { before, after };
}

import { buildCanonicalRequest } from "./canonical.js";
import { resolvePiConfig, sessionId } from "./config.js";
import { postJSON } from "./http.js";

function reason(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  if (typeof body.decision?.reason === "string") return body.decision.reason.trim();
  return "";
}

function headers(value, name) {
  return value ? { [name]: value } : {};
}

export function createArbiterPiGuardrail({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = resolvePiConfig(env);
  const protectedTools = new Set(config.protectedTools);
  const verifiedCalls = new Set();

  function isProtected(toolName) {
    return config.protectAll || protectedTools.has(toolName);
  }

  function block(message) {
    return { block: true, reason: message };
  }

  function interceptHeaders() {
    return {
      ...headers(config.gatewayKey, "X-Arbiter-Gateway-Key"),
      ...headers(config.bearerToken, "Authorization")
    };
  }

  async function beforeToolCall(event, ctx) {
    if (!isProtected(event?.toolName)) return undefined;

    if (config.missing.length) {
      const message = `Arbiter Pi extension misconfigured: missing ${config.missing.join(", ")}`;
      if (config.failClosed) return block(message);
      logger.warn?.(`${message}; allowing because ARBITER_PI_FAIL_CLOSED=false`);
      return undefined;
    }

    const canonical = buildCanonicalRequest({ config, event, ctx });
    let intercept;
    try {
      intercept = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/intercept/framework/generic",
        headers: interceptHeaders(),
        payload: canonical,
        timeoutMs: config.timeoutMs,
        signal: ctx?.signal
      });
    } catch (error) {
      const message = `Arbiter intercept failed: ${String(error)}`;
      if (config.failClosed) return block(message);
      logger.warn?.(`${message}; allowing because ARBITER_PI_FAIL_CLOSED=false`);
      return undefined;
    }

    const interceptReason = reason(intercept.body);
    if (intercept.status !== 200) {
      if (intercept.status === 403) return block(interceptReason || "Blocked by Arbiter policy");
      const message = `Arbiter intercept failed (${intercept.status})${interceptReason ? `: ${interceptReason}` : ""}`;
      if (config.failClosed) return block(message);
      logger.warn?.(`${message}; allowing because ARBITER_PI_FAIL_CLOSED=false`);
      return undefined;
    }

    const token = intercept.body?.token;
    if (typeof token !== "string" || !token.trim()) {
      const message = "Arbiter intercept response missing execution permit";
      if (config.failClosed) return block(message);
      logger.warn?.(`${message}; allowing because ARBITER_PI_FAIL_CLOSED=false`);
      return undefined;
    }

    let verification;
    try {
      verification = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/execute/verify/canonical",
        headers: headers(config.serviceKey, "X-Arbiter-Service-Key"),
        payload: { token, request: canonical },
        timeoutMs: config.timeoutMs,
        signal: ctx?.signal
      });
    } catch (error) {
      const message = `Arbiter permit verification failed: ${String(error)}`;
      if (config.failClosed) return block(message);
      logger.warn?.(`${message}; allowing because ARBITER_PI_FAIL_CLOSED=false`);
      return undefined;
    }

    if (verification.status !== 200) {
      const verifyReason = reason(verification.body);
      return block(`Arbiter permit verification denied${verifyReason ? `: ${verifyReason}` : ""}`);
    }

    verifiedCalls.add(event.toolCallId);
    return undefined;
  }

  async function afterToolResult(event, ctx) {
    if (!verifiedCalls.delete(event?.toolCallId) || !config.recordState) return undefined;

    const payload = {
      tenant_id: config.tenantId,
      actor_id: config.actorId,
      tool_name: event.toolName,
      outcome: event.isError ? "error" : "allowed"
    };
    const session = sessionId(ctx);
    if (session) payload.session_id = session;

    try {
      const response = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/state/actions",
        headers: headers(config.serviceKey, "X-Arbiter-Service-Key"),
        payload,
        timeoutMs: config.timeoutMs,
        signal: ctx?.signal
      });
      if (response.status !== 200 && response.status !== 202) {
        logger.warn?.(`Arbiter state record returned status=${response.status}`);
      }
    } catch (error) {
      logger.warn?.(`Arbiter state record failed: ${String(error)}`);
    }
    return undefined;
  }

  function status() {
    const protectedLabel = config.protectAll ? "all tools" : config.protectedTools.join(", ");
    const ready = config.missing.length === 0;
    return {
      ready,
      protectedTools: protectedLabel,
      message: ready
        ? `Arbiter is enforcing ${protectedLabel} at ${config.url} for tenant ${config.tenantId} as ${config.actorId}.`
        : `Arbiter is not ready: missing ${config.missing.join(", ")}.`
    };
  }

  return { beforeToolCall, afterToolResult, status };
}

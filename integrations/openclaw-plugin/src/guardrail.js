import { buildCanonicalRequest, createRequestId } from "./canonical.js";
import { resolveActorId, resolvePluginConfig } from "./config.js";
import { postJSON } from "./http.js";

function isProtectedTool(toolSet, toolName) {
  return typeof toolName === "string" && toolSet.has(toolName);
}

function decisionReason(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error.trim();
  }
  const decision = body.decision;
  if (decision && typeof decision === "object" && typeof decision.reason === "string") {
    return decision.reason.trim();
  }
  return "";
}

function block(reason) {
  return {
    block: true,
    blockReason: reason
  };
}

function configError(config) {
  if (!config.missing.length) {
    return "";
  }
  return `arbiter plugin misconfigured: missing ${config.missing.join(", ")}`;
}

function serviceHeaders(config) {
  return config.serviceKey ? { "X-Arbiter-Service-Key": config.serviceKey } : {};
}

function gatewayHeaders(config) {
  return config.gatewayKey ? { "X-Arbiter-Gateway-Key": config.gatewayKey } : {};
}

export function createArbiterGuardrail({
  pluginConfig,
  logger,
  fetchImpl = globalThis.fetch,
  env = process.env
}) {
  const config = resolvePluginConfig(pluginConfig, env);
  const protectedTools = new Set(config.protectTools);

  async function beforeToolCall(event, ctx) {
    if (!isProtectedTool(protectedTools, event?.toolName)) {
      return;
    }

    const cfgError = configError(config);
    if (cfgError) {
      if (config.failClosed) {
        return block(cfgError);
      }
      logger?.warn?.(`${cfgError}; allowing because failClosed=false`);
      return;
    }

    const actorId = resolveActorId(config, ctx);
    const requestId = createRequestId(event);
    const canonical = buildCanonicalRequest({
      config,
      event,
      ctx,
      actorId,
      requestId
    });

    let intercept;
    try {
      intercept = await postJSON({
        fetchImpl,
        baseUrl: config.arbiterUrl,
        path: "/v1/intercept/framework/generic",
        headers: gatewayHeaders(config),
        payload: canonical,
        timeoutMs: config.timeoutMs
      });
    } catch (err) {
      if (config.failClosed) {
        return block(`arbiter intercept failed: ${String(err)}`);
      }
      logger?.warn?.(`arbiter intercept failed; allowing because failClosed=false: ${String(err)}`);
      return;
    }

    const interceptReason = decisionReason(intercept.body);
    if (intercept.status !== 200) {
      if (intercept.status === 403) {
        return block(interceptReason || "blocked by arbiter policy");
      }
      if (config.failClosed) {
        return block(`arbiter intercept failed (${intercept.status})${interceptReason ? `: ${interceptReason}` : ""}`);
      }
      logger?.warn?.(`arbiter intercept status=${intercept.status}; allowing because failClosed=false`);
      return;
    }

    const token = intercept.body?.token;
    if (typeof token !== "string" || !token.trim()) {
      if (config.failClosed) {
        return block("arbiter intercept response missing token");
      }
      logger?.warn?.("arbiter intercept response missing token; allowing because failClosed=false");
      return;
    }

    let verify;
    try {
      verify = await postJSON({
        fetchImpl,
        baseUrl: config.arbiterUrl,
        path: "/v1/execute/verify/canonical",
        headers: serviceHeaders(config),
        payload: {
          token,
          request: canonical
        },
        timeoutMs: config.timeoutMs
      });
    } catch (err) {
      if (config.failClosed) {
        return block(`arbiter verify failed: ${String(err)}`);
      }
      logger?.warn?.(`arbiter verify failed; allowing because failClosed=false: ${String(err)}`);
      return;
    }

    if (verify.status !== 200) {
      const verifyReason = decisionReason(verify.body);
      return block(`arbiter verify denied${verifyReason ? `: ${verifyReason}` : ""}`);
    }
  }

  async function afterToolCall(event, ctx) {
    if (!config.recordState || !isProtectedTool(protectedTools, event?.toolName)) {
      return;
    }
    if (!config.tenantId) {
      return;
    }

    const actorId = resolveActorId(config, ctx);
    const outcome = event?.error ? "error" : "allowed";
    const payload = {
      tenant_id: config.tenantId,
      actor_id: actorId,
      tool_name: event.toolName,
      outcome
    };
    if (ctx?.sessionId && typeof ctx.sessionId === "string") {
      payload.session_id = ctx.sessionId;
    } else if (ctx?.sessionKey && typeof ctx.sessionKey === "string") {
      payload.session_id = ctx.sessionKey;
    }

    try {
      const response = await postJSON({
        fetchImpl,
        baseUrl: config.arbiterUrl,
        path: "/v1/state/actions",
        headers: serviceHeaders(config),
        payload,
        timeoutMs: config.timeoutMs
      });
      if (response.status !== 202 && response.status !== 200) {
        logger?.warn?.(`arbiter state record returned status=${response.status}`);
      }
    } catch (err) {
      logger?.warn?.(`arbiter state record failed: ${String(err)}`);
    }
  }

  return {
    beforeToolCall,
    afterToolCall
  };
}

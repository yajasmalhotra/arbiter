import { resolveClaudeConfig } from "./config.js";
import { postJSON } from "./http.js";
import { createMarkerStore } from "./markers.js";

function reason(body) {
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  if (typeof body?.decision?.reason === "string") return body.decision.reason.trim();
  return "";
}

function optionalHeader(value, name) {
  return value ? { [name]: value } : {};
}

function deny(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message
    }
  };
}

function canonicalToolName(toolName) {
  const builtins = {
    Bash: "bash",
    PowerShell: "bash",
    Write: "write",
    Edit: "edit",
    NotebookEdit: "edit",
    Read: "read"
  };
  return builtins[toolName] ?? toolName;
}

function canonical(config, input) {
  return {
    schema_version: "v1alpha1",
    metadata: {
      request_id: `claude-code:${input.session_id}:${input.tool_use_id}`,
      session_id: input.session_id,
      tenant_id: config.tenantId,
      provider: "anthropic"
    },
    agent_context: {
      actor: { id: config.actorId, type: "agent" },
      labels: { harness_tool: input.tool_name }
    },
    tool_name: canonicalToolName(input.tool_name),
    parameters: input.tool_input ?? {}
  };
}

export function createArbiterClaudeGuardrail({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = resolveClaudeConfig(env);
  const protectedTools = new Set(config.protectedTools);
  const markers = createMarkerStore(config.markerDir);

  function isProtected(tool) {
    return config.protectAll || protectedTools.has(tool);
  }

  function developmentFailure(message) {
    if (config.failClosed) return deny(message);
    logger.warn?.(`${message}; allowing because ARBITER_CLAUDE_FAIL_CLOSED=false`);
    return undefined;
  }

  async function before(input) {
    if (!isProtected(input?.tool_name)) return undefined;
    if (!input?.session_id || !input?.tool_use_id) {
      return developmentFailure("Arbiter Claude Code plugin received a protected call without session_id or tool_use_id");
    }
    if (config.missing.length) {
      return developmentFailure(`Arbiter Claude Code plugin misconfigured: missing ${config.missing.join(", ")}`);
    }

    const request = canonical(config, input);
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
      return developmentFailure(`Arbiter intercept failed: ${String(error)}`);
    }

    const interceptReason = reason(intercept.body);
    if (intercept.status !== 200) {
      if (intercept.status === 403) return deny(interceptReason || "Blocked by Arbiter policy");
      return developmentFailure(`Arbiter intercept failed (${intercept.status})${interceptReason ? `: ${interceptReason}` : ""}`);
    }

    const token = intercept.body?.token;
    if (typeof token !== "string" || !token.trim()) {
      return developmentFailure("Arbiter intercept response missing execution permit");
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
      return developmentFailure(`Arbiter permit verification failed: ${String(error)}`);
    }
    if (verification.status !== 200) {
      const verificationReason = reason(verification.body);
      return deny(`Arbiter permit verification denied${verificationReason ? `: ${verificationReason}` : ""}`);
    }

    try {
      markers.mark(input);
    } catch (error) {
      return developmentFailure(`Arbiter could not persist verified-call state: ${String(error)}`);
    }
    return undefined;
  }

  async function after(input, outcome) {
    if (!markers.consume(input) || !config.recordState) return undefined;
    try {
      const response = await postJSON({
        fetchImpl,
        baseUrl: config.url,
        path: "/v1/state/actions",
        headers: optionalHeader(config.serviceKey, "X-Arbiter-Service-Key"),
        payload: {
          tenant_id: config.tenantId,
          actor_id: config.actorId,
          session_id: input.session_id,
          tool_name: canonicalToolName(input.tool_name),
          outcome
        },
        timeoutMs: config.timeoutMs
      });
      if (response.status !== 200 && response.status !== 202) {
        logger.warn?.(`Arbiter state record returned status=${response.status}`);
      }
    } catch (error) {
      logger.warn?.(`Arbiter state record failed: ${String(error)}`);
    }
    return undefined;
  }

  async function handle(input) {
    switch (input?.hook_event_name) {
      case "PreToolUse": return before(input);
      case "PostToolUse": return after(input, "allowed");
      case "PostToolUseFailure": return after(input, "error");
      default: return undefined;
    }
  }

  return { before, after, handle };
}

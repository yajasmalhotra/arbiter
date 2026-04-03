import { resolveSessionMetadata } from "./config.js";

const SCHEMA_VERSION = "v1alpha1";

function randomSuffix() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createRequestId(event) {
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";

  if (runId && toolCallId) {
    return `${runId}:${toolCallId}`;
  }
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  if (runId) {
    return `${runId}:${randomSuffix()}`;
  }
  return `arbiter-${randomSuffix()}`;
}

export function buildCanonicalRequest({ config, event, ctx, actorId, requestId }) {
  const session = resolveSessionMetadata(ctx);
  const metadata = {
    request_id: requestId,
    tenant_id: config.tenantId,
    provider: "framework"
  };

  if (session.sessionId) {
    metadata.session_id = session.sessionId;
  } else if (session.sessionKey) {
    metadata.session_id = session.sessionKey;
  }
  if (typeof event.runId === "string" && event.runId.trim()) {
    metadata.trace_id = event.runId.trim();
  }

  return {
    schema_version: SCHEMA_VERSION,
    metadata,
    agent_context: {
      actor: {
        id: actorId
      }
    },
    tool_name: event.toolName,
    parameters: event.params ?? {}
  };
}

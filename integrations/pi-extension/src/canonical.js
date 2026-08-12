import { sessionId } from "./config.js";

export function buildCanonicalRequest({ config, event, ctx }) {
  const session = sessionId(ctx);
  const metadata = {
    request_id: session ? `pi:${session}:${event.toolCallId}` : `pi:${event.toolCallId}`,
    tenant_id: config.tenantId,
    provider: "pi"
  };
  if (session) metadata.session_id = session;

  return {
    schema_version: "v1alpha1",
    metadata,
    agent_context: {
      actor: {
        id: config.actorId,
        type: "agent"
      }
    },
    tool_name: event.toolName,
    parameters: event.input ?? {}
  };
}

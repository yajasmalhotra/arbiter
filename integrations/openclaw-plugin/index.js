import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createArbiterGuardrail } from "./src/guardrail.js";

export default definePluginEntry({
  id: "arbiter-openclaw",
  name: "Arbiter Guardrails",
  description: "Enforce Arbiter policy decisions before OpenClaw tool execution.",
  register(api) {
    const guardrail = createArbiterGuardrail({
      pluginConfig: api.pluginConfig,
      logger: api.logger,
      fetchImpl: globalThis.fetch
    });

    api.on("before_tool_call", guardrail.beforeToolCall);
    api.on("after_tool_call", guardrail.afterToolCall);
  }
});

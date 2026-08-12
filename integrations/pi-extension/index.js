import { createArbiterPiGuardrail } from "./src/guardrail.js";

export default function arbiterPiExtension(pi) {
  const guardrail = createArbiterPiGuardrail();

  pi.on("tool_call", guardrail.beforeToolCall);
  pi.on("tool_result", guardrail.afterToolResult);

  pi.on("session_start", (_event, ctx) => {
    const status = guardrail.status();
    ctx.ui.setStatus("arbiter", status.ready ? `Arbiter · ${status.protectedTools}` : "Arbiter · misconfigured");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("arbiter", undefined);
  });

  pi.registerCommand("arbiter", {
    description: "Show Arbiter guardrail status for this Pi session",
    handler: async (_args, ctx) => {
      const status = guardrail.status();
      ctx.ui.notify(status.message, status.ready ? "info" : "error");
    }
  });
}

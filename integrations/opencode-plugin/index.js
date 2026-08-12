import { createArbiterOpenCodeGuardrail } from "./src/guardrail.js";

export const ArbiterPlugin = async () => {
  const guardrail = createArbiterOpenCodeGuardrail();
  return {
    "tool.execute.before": guardrail.before,
    "tool.execute.after": guardrail.after
  };
};

export default ArbiterPlugin;

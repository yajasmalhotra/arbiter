/** Default OpenAI-style intercept body for the policy test panel. */
export const DEFAULT_OPENAI_INTERCEPT_JSON = JSON.stringify(
  {
    metadata: {
      request_id: "control-plane-test",
      tenant_id: "tenant-demo",
      provider: "openai"
    },
    agent_context: {
      actor: { id: "user-1" }
    },
    tool_call: {
      type: "function",
      function: {
        name: "send_slack_message",
        arguments: JSON.stringify({
          channel: "ops",
          message: "hello from control plane"
        })
      }
    }
  },
  null,
  2
);

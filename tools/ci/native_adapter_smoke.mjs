import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createArbiterPiGuardrail } from "../../integrations/pi-extension/src/guardrail.js";
import { createArbiterOpenCodeGuardrail } from "../../integrations/opencode-plugin/src/guardrail.js";
import { createArbiterClaudeGuardrail } from "../../integrations/claude-code-plugin/src/guardrail.js";

const canaryCommand = "mkdir -p /tmp/arbiter-deny-test/native-adapter-smoke";

const pi = createArbiterPiGuardrail({
  env: {
    ...process.env,
    ARBITER_PI_PROTECT_TOOLS: "*",
    ARBITER_PI_ACTOR_ID: "pi-smoke"
  }
});
const piDenied = await pi.beforeToolCall(
  { toolName: "bash", toolCallId: "pi-deny", input: { command: canaryCommand } },
  { sessionManager: { getSessionId: () => "pi-smoke-session" } }
);
assert.equal(piDenied?.block, true, "Pi must block the policy canary");
assert.match(piDenied.reason, /denied/i);
assert.equal(
  await pi.beforeToolCall(
    { toolName: "bash", toolCallId: "pi-allow", input: { command: "pwd" } },
    { sessionManager: { getSessionId: () => "pi-smoke-session" } }
  ),
  undefined
);
await pi.afterToolResult(
  { toolName: "bash", toolCallId: "pi-allow", isError: false },
  { sessionManager: { getSessionId: () => "pi-smoke-session" } }
);

const opencode = createArbiterOpenCodeGuardrail({
  env: {
    ...process.env,
    ARBITER_OPENCODE_PROTECT_TOOLS: "*",
    ARBITER_OPENCODE_ACTOR_ID: "opencode-smoke"
  }
});
await assert.rejects(
  opencode.before(
    { tool: "bash", sessionID: "opencode-smoke-session", callID: "opencode-deny" },
    { args: { command: canaryCommand } }
  ),
  /denied/i
);
const opencodeAllowed = { tool: "bash", sessionID: "opencode-smoke-session", callID: "opencode-allow" };
await opencode.before(opencodeAllowed, { args: { command: "pwd" } });
await opencode.after(opencodeAllowed, { output: process.cwd() });

const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-claude-smoke-"));
try {
  const claude = createArbiterClaudeGuardrail({
    env: {
      ...process.env,
      ARBITER_CLAUDE_PROTECT_TOOLS: "*",
      ARBITER_CLAUDE_ACTOR_ID: "claude-smoke",
      ARBITER_CLAUDE_MARKER_DIR: markerDir
    }
  });
  const claudeDenied = await claude.handle({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: canaryCommand },
    session_id: "claude-smoke-session",
    tool_use_id: "claude-deny"
  });
  assert.equal(claudeDenied?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(claudeDenied.hookSpecificOutput.permissionDecisionReason, /denied/i);

  const claudeCall = {
    tool_name: "Bash",
    tool_input: { command: "pwd" },
    session_id: "claude-smoke-session",
    tool_use_id: "claude-allow"
  };
  assert.equal(await claude.handle({ ...claudeCall, hook_event_name: "PreToolUse" }), undefined);
  assert.equal(fs.readdirSync(markerDir).length, 1, "Claude pre-hook must persist verified-call state");
  await claude.handle({ ...claudeCall, hook_event_name: "PostToolUse", tool_response: { stdout: process.cwd() } });
  assert.equal(fs.readdirSync(markerDir).length, 0, "Claude post-hook must consume verified-call state");
} finally {
  fs.rmSync(markerDir, { recursive: true, force: true });
}

console.log("native adapter smoke passed: Pi, OpenCode, Claude Code");

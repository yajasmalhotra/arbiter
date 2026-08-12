import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveClaudeConfig } from "../src/config.js";
import { createArbiterClaudeGuardrail } from "../src/guardrail.js";

const missingLocalConfig = "/path/that/does/not/exist";

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-claude-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function env(t, overrides = {}) {
  return {
    ARBITER_CLAUDE_LOCAL_CONFIG: missingLocalConfig,
    ARBITER_CLAUDE_URL: "http://arbiter.test",
    ARBITER_CLAUDE_TENANT_ID: "tenant-claude",
    ARBITER_CLAUDE_MARKER_DIR: tempDirectory(t),
    ...overrides
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function event(overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "toolu-1",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    ...overrides
  };
}

test("uses side-effecting defaults and shared configuration aliases", (t) => {
  const defaults = resolveClaudeConfig(env(t));
  assert.deepEqual(defaults.protectedTools, ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit"]);
  assert.equal(defaults.failClosed, true);
  assert.equal(defaults.actorId, "claude-code-agent");

  const shared = resolveClaudeConfig({
    ARBITER_CLAUDE_LOCAL_CONFIG: missingLocalConfig,
    ARBITER_URL: "http://shared.test",
    ARBITER_TENANT_ID: "shared-tenant",
    ARBITER_ACTOR_ID: "shared-actor",
    ARBITER_WORKLOAD_TOKEN: "Bearer workload",
    ARBITER_CLAUDE_MARKER_DIR: tempDirectory(t)
  });
  assert.equal(shared.url, "http://shared.test");
  assert.equal(shared.tenantId, "shared-tenant");
  assert.equal(shared.actorId, "shared-actor");
  assert.equal(shared.bearerToken, "Bearer workload");
});

test("returns a structured denial before Claude executes a blocked tool", async (t) => {
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t),
    fetchImpl: async () => response(403, { decision: { reason: "command denied" } })
  });
  const result = await guardrail.handle(event());
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(result.hookSpecificOutput.permissionDecisionReason, "command denied");
});

test("stays silent after verify so Claude permissions still apply", async (t) => {
  const requests = [];
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t),
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit" });
      return response(200, { status: "verified" });
    }
  });
  const result = await guardrail.handle(event());
  assert.equal(result, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload.parameters, { command: "npm test" });
  assert.equal(requests[0].payload.tool_name, "bash");
  assert.equal(requests[0].payload.protocol, undefined);
  assert.equal(requests[0].payload.agent_context.labels.harness_tool, "Bash");
  assert.equal(requests[0].payload.metadata.request_id, "claude-code:session-1:toolu-1");
  assert.deepEqual(requests[1].payload.request, requests[0].payload);
});

test("records success only after the corresponding verified tool executes", async (t) => {
  const requests = [];
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t),
    fetchImpl: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit" });
      if (url.endsWith("/v1/execute/verify/canonical")) return response(200, { status: "verified" });
      return response(202, { recorded: true });
    }
  });
  await guardrail.handle(event());
  await guardrail.handle(event({ hook_event_name: "PostToolUse", tool_response: { success: true } }));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].payload.outcome, "allowed");

  await guardrail.handle(event({ hook_event_name: "PostToolUse" }));
  assert.equal(requests.length, 3);
});

test("records a verified tool failure and consumes its marker", async (t) => {
  const requests = [];
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t),
    fetchImpl: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit" });
      if (url.endsWith("/v1/execute/verify/canonical")) return response(200, {});
      return response(202, {});
    }
  });
  await guardrail.handle(event());
  await guardrail.handle(event({ hook_event_name: "PostToolUseFailure", error: "command failed" }));
  assert.equal(requests[2].payload.outcome, "error");
});

test("supports wildcard protection and fails closed on transport errors", async (t) => {
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t, { ARBITER_CLAUDE_PROTECT_TOOLS: "*" }),
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const result = await guardrail.handle(event({ tool_name: "mcp__payments__refund", tool_input: { amount: 500 } }));
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /intercept failed.*offline/);
});

test("does not contact Arbiter for an unprotected read", async (t) => {
  let calls = 0;
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t),
    fetchImpl: async () => {
      calls += 1;
      return response(500, {});
    }
  });
  const result = await guardrail.handle(event({ tool_name: "Read", tool_input: { file_path: "README.md" } }));
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("explicit development fail-open allows an unavailable Arbiter", async (t) => {
  const warnings = [];
  const guardrail = createArbiterClaudeGuardrail({
    env: env(t, { ARBITER_CLAUDE_FAIL_CLOSED: "false" }),
    fetchImpl: async () => { throw new Error("offline"); },
    logger: { warn: (message) => warnings.push(message) }
  });
  assert.equal(await guardrail.handle(event()), undefined);
  assert.match(warnings[0], /allowing because ARBITER_CLAUDE_FAIL_CLOSED=false/);
});

test("fails closed when Claude omits call correlation identifiers", async (t) => {
  const guardrail = createArbiterClaudeGuardrail({ env: env(t) });
  const result = await guardrail.handle(event({ tool_use_id: undefined }));
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /without session_id or tool_use_id/);
});

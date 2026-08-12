import assert from "node:assert/strict";
import test from "node:test";

import ArbiterPlugin from "../index.js";
import { resolveOpenCodeConfig } from "../src/config.js";
import { createArbiterOpenCodeGuardrail } from "../src/guardrail.js";

const missingLocalConfig = "/path/that/does/not/exist";

function env(overrides = {}) {
  return {
    ARBITER_OPENCODE_LOCAL_CONFIG: missingLocalConfig,
    ARBITER_OPENCODE_URL: "http://arbiter.test",
    ARBITER_OPENCODE_TENANT_ID: "tenant-opencode",
    ...overrides
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("uses local-safe defaults and shared configuration aliases", () => {
  const defaults = resolveOpenCodeConfig(env());
  assert.deepEqual(defaults.protectedTools, ["bash", "edit", "write", "apply_patch"]);
  assert.equal(defaults.failClosed, true);
  assert.equal(defaults.actorId, "opencode-agent");

  const shared = resolveOpenCodeConfig({
    ARBITER_OPENCODE_LOCAL_CONFIG: missingLocalConfig,
    ARBITER_URL: "http://shared.test",
    ARBITER_TENANT_ID: "shared-tenant",
    ARBITER_ACTOR_ID: "shared-actor",
    ARBITER_WORKLOAD_TOKEN: "Bearer workload"
  });
  assert.equal(shared.url, "http://shared.test");
  assert.equal(shared.tenantId, "shared-tenant");
  assert.equal(shared.actorId, "shared-actor");
  assert.equal(shared.bearerToken, "Bearer workload");
});

test("blocks a denial before OpenCode executes the tool", async () => {
  const guardrail = createArbiterOpenCodeGuardrail({
    env: env(),
    fetchImpl: async () => response(403, { decision: { reason: "command denied" } })
  });
  await assert.rejects(
    guardrail.before(
      { tool: "bash", sessionID: "session-1", callID: "call-1" },
      { args: { command: "danger" } }
    ),
    /command denied/
  );
});

test("verifies the exact canonical request and records only executed calls", async () => {
  const requests = [];
  const guardrail = createArbiterOpenCodeGuardrail({
    env: env(),
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit" });
      if (url.endsWith("/v1/execute/verify/canonical")) return response(200, { valid: true });
      return response(202, { recorded: true });
    }
  });
  const input = { tool: "write", sessionID: "session-2", callID: "call-2" };
  const output = { args: { filePath: "notes.txt", content: "hello" } };

  await guardrail.before(input, output);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload.parameters, output.args);
  assert.equal(requests[0].payload.metadata.request_id, "opencode:session-2:call-2");
  assert.deepEqual(requests[1].payload.request, requests[0].payload);

  await guardrail.after(input, { title: "Wrote file", output: "done" });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].payload.outcome, "allowed");

  await guardrail.after(input, {});
  assert.equal(requests.length, 3);
});

test("supports all tools and fails closed on transport errors", async () => {
  const guardrail = createArbiterOpenCodeGuardrail({
    env: env({ ARBITER_OPENCODE_PROTECT_TOOLS: "*" }),
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  await assert.rejects(
    guardrail.before(
      { tool: "custom_business_tool", sessionID: "session-3", callID: "call-3" },
      { args: { amount: 500 } }
    ),
    /intercept failed.*offline/
  );
});

test("blocks when execution permit verification is denied", async () => {
  const guardrail = createArbiterOpenCodeGuardrail({
    env: env(),
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit" });
      return response(403, { error: "permit already consumed" });
    }
  });
  await assert.rejects(
    guardrail.before(
      { tool: "edit", sessionID: "session-verify", callID: "call-verify" },
      { args: { filePath: "notes.txt" } }
    ),
    /verification denied: permit already consumed/
  );
});

test("does not contact Arbiter for an unprotected read", async () => {
  let calls = 0;
  const guardrail = createArbiterOpenCodeGuardrail({
    env: env(),
    fetchImpl: async () => {
      calls += 1;
      return response(500, {});
    }
  });
  await guardrail.before(
    { tool: "read", sessionID: "session-4", callID: "call-4" },
    { args: { filePath: "README.md" } }
  );
  assert.equal(calls, 0);
});

test("exports the current OpenCode before and after hook names", async () => {
  const hooks = await ArbiterPlugin();
  assert.equal(typeof hooks["tool.execute.before"], "function");
  assert.equal(typeof hooks["tool.execute.after"], "function");
});

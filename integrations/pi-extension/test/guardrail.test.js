import assert from "node:assert/strict";
import test from "node:test";

import arbiterPiExtension from "../index.js";
import { resolvePiConfig } from "../src/config.js";
import { createArbiterPiGuardrail } from "../src/guardrail.js";

const missingLocalConfig = "/tmp/arbiter-pi-test-missing-config.json";

function env(overrides = {}) {
  return {
    ARBITER_PI_LOCAL_CONFIG: missingLocalConfig,
    ARBITER_PI_URL: "http://arbiter.test",
    ARBITER_PI_TENANT_ID: "tenant-pi",
    ARBITER_PI_ACTOR_ID: "pi-coder",
    ...overrides
  };
}

function context() {
  return {
    sessionManager: { getSessionId: () => "session-1" },
    signal: undefined,
    ui: { notify() {}, setStatus() {} }
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("config protects side-effecting Pi tools and fails closed by default", () => {
  const config = resolvePiConfig(env());
  assert.deepEqual(config.protectedTools, ["bash", "edit", "write"]);
  assert.equal(config.failClosed, true);
  assert.deepEqual(config.missing, []);
});

test("blocks a policy denial before Pi executes the tool", async () => {
  const fetchImpl = async () => response(403, { decision: { reason: "shell command denied" } });
  const guardrail = createArbiterPiGuardrail({ env: env(), fetchImpl });

  const result = await guardrail.beforeToolCall(
    { toolName: "bash", toolCallId: "call-denied", input: { command: "rm -rf /tmp/example" } },
    context()
  );

  assert.deepEqual(result, { block: true, reason: "shell command denied" });
});

test("verifies an allow permit and records only the executed verified call", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith("/v1/intercept/framework/generic")) return response(200, { token: "permit-1" });
    if (url.endsWith("/v1/execute/verify/canonical")) return response(200, { status: "verified" });
    return response(202, { status: "recorded" });
  };
  const guardrail = createArbiterPiGuardrail({
    env: env({
      ARBITER_PI_BEARER_TOKEN: "Bearer workload-token",
      ARBITER_GATEWAY_SHARED_KEY: "gateway-key",
      ARBITER_SERVICE_SHARED_KEY: "service-key"
    }),
    fetchImpl
  });
  const ctx = context();
  const event = { toolName: "write", toolCallId: "call-allowed", input: { path: "notes.txt", content: "hello" } };

  assert.equal(await guardrail.beforeToolCall(event, ctx), undefined);
  await guardrail.afterToolResult({ ...event, isError: false }, ctx);
  await guardrail.afterToolResult({ ...event, isError: false }, ctx);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.metadata.request_id, "pi:session-1:call-allowed");
  assert.equal(calls[0].body.metadata.provider, "pi");
  assert.equal(calls[0].body.tool_name, "write");
  assert.deepEqual(calls[0].body.parameters, event.input);
  assert.equal(calls[0].options.headers.Authorization, "Bearer workload-token");
  assert.equal(calls[0].options.headers["X-Arbiter-Gateway-Key"], "gateway-key");
  assert.equal(calls[1].body.token, "permit-1");
  assert.equal(calls[1].options.headers["X-Arbiter-Service-Key"], "service-key");
  assert.deepEqual(calls[2].body, {
    tenant_id: "tenant-pi",
    actor_id: "pi-coder",
    tool_name: "write",
    outcome: "allowed",
    session_id: "session-1"
  });
});

test("does not call Arbiter for an unprotected read", async () => {
  let called = false;
  const guardrail = createArbiterPiGuardrail({
    env: env(),
    fetchImpl: async () => {
      called = true;
      return response(500, {});
    }
  });

  assert.equal(await guardrail.beforeToolCall({ toolName: "read", toolCallId: "read-1", input: {} }, context()), undefined);
  assert.equal(called, false);
});

test("supports protecting every Pi tool, including reads and custom tools", async () => {
  let calls = 0;
  const guardrail = createArbiterPiGuardrail({
    env: env({ ARBITER_PI_PROTECT_TOOLS: "*" }),
    fetchImpl: async () => {
      calls += 1;
      return response(403, { decision: { reason: "read requires approval" } });
    }
  });

  const result = await guardrail.beforeToolCall({ toolName: "read", toolCallId: "read-all", input: { path: "secret.txt" } }, context());
  assert.deepEqual(result, { block: true, reason: "read requires approval" });
  assert.equal(calls, 1);
});

test("blocks protected tools when required configuration is missing", async () => {
  let called = false;
  const guardrail = createArbiterPiGuardrail({
    env: { ARBITER_PI_LOCAL_CONFIG: missingLocalConfig },
    fetchImpl: async () => {
      called = true;
      return response(200, { token: "unexpected" });
    }
  });

  const result = await guardrail.beforeToolCall({ toolName: "bash", toolCallId: "missing-config", input: {} }, context());
  assert.equal(result.block, true);
  assert.match(result.reason, /ARBITER_PI_URL/);
  assert.match(result.reason, /ARBITER_PI_TENANT_ID/);
  assert.equal(called, false);
});

test("fails closed on transport errors and permits explicit development fail-open", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const closed = createArbiterPiGuardrail({ env: env(), fetchImpl });
  const denied = await closed.beforeToolCall({ toolName: "edit", toolCallId: "edit-1", input: {} }, context());
  assert.equal(denied.block, true);
  assert.match(denied.reason, /offline/);

  const warnings = [];
  const open = createArbiterPiGuardrail({
    env: env({ ARBITER_PI_FAIL_CLOSED: "false" }),
    fetchImpl,
    logger: { warn: (message) => warnings.push(message) }
  });
  assert.equal(await open.beforeToolCall({ toolName: "edit", toolCallId: "edit-2", input: {} }, context()), undefined);
  assert.equal(warnings.length, 1);
});

test("registers Pi lifecycle hooks and the status command", () => {
  const events = new Map();
  const commands = new Map();
  arbiterPiExtension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, options) => commands.set(name, options)
  });

  assert.equal(typeof events.get("tool_call"), "function");
  assert.equal(typeof events.get("tool_result"), "function");
  assert.equal(typeof events.get("session_start"), "function");
  assert.equal(typeof commands.get("arbiter")?.handler, "function");
});

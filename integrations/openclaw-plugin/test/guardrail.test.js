import test from "node:test";
import assert from "node:assert/strict";

import { createArbiterGuardrail } from "../src/guardrail.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function createFetchSequence(sequence) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = sequence.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchImpl, calls };
}

function parseCallBody(call) {
  return JSON.parse(call.init.body);
}

function createLogger() {
  const warnings = [];
  return {
    logger: {
      warn(message) {
        warnings.push(String(message));
      }
    },
    warnings
  };
}

function pluginConfig(overrides = {}) {
  return {
    arbiterUrl: "http://localhost:8080",
    tenantId: "tenant-demo",
    gatewayKey: "gw-key",
    serviceKey: "svc-key",
    ...overrides
  };
}

test("beforeToolCall blocks when intercept is denied", async () => {
  const { fetchImpl, calls } = createFetchSequence([
    jsonResponse(403, {
      decision: {
        allow: false,
        reason: "tool policy denied"
      }
    })
  ]);
  const { logger } = createLogger();

  const guardrail = createArbiterGuardrail({
    pluginConfig: pluginConfig(),
    logger,
    fetchImpl
  });

  const result = await guardrail.beforeToolCall(
    {
      toolName: "exec",
      params: { command: "rm -rf /tmp/cache" },
      runId: "run-1",
      toolCallId: "call-1"
    },
    {
      agentId: "agent-1",
      sessionId: "session-1"
    }
  );

  assert.equal(result.block, true);
  assert.match(result.blockReason, /tool policy denied/i);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/intercept\/framework\/generic$/);

  const body = parseCallBody(calls[0]);
  assert.equal(body.metadata.tenant_id, "tenant-demo");
  assert.equal(body.agent_context.actor.id, "agent-1");
  assert.equal(body.tool_name, "exec");
});

test("beforeToolCall blocks when verify is denied", async () => {
  const { fetchImpl, calls } = createFetchSequence([
    jsonResponse(200, { decision: { allow: true }, token: "token-1" }),
    jsonResponse(403, { error: "replay detected" })
  ]);
  const { logger } = createLogger();

  const guardrail = createArbiterGuardrail({
    pluginConfig: pluginConfig(),
    logger,
    fetchImpl
  });

  const result = await guardrail.beforeToolCall(
    {
      toolName: "process",
      params: { command: ["ls", "-la"] },
      runId: "run-2"
    },
    {
      agentId: "agent-2"
    }
  );

  assert.equal(result.block, true);
  assert.match(result.blockReason, /verify denied/i);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v1\/execute\/verify\/canonical$/);
});

test("beforeToolCall fails closed on transport error", async () => {
  const { fetchImpl } = createFetchSequence([new Error("network down")]);
  const { logger } = createLogger();

  const guardrail = createArbiterGuardrail({
    pluginConfig: pluginConfig(),
    logger,
    fetchImpl
  });

  const result = await guardrail.beforeToolCall(
    {
      toolName: "exec",
      params: { command: "ls" }
    },
    {
      agentId: "agent-3"
    }
  );

  assert.equal(result.block, true);
  assert.match(result.blockReason, /intercept failed/i);
});

test("beforeToolCall allows when intercept and verify both pass", async () => {
  const { fetchImpl, calls } = createFetchSequence([
    jsonResponse(200, { decision: { allow: true }, token: "token-allow" }),
    jsonResponse(200, { status: "verified" })
  ]);
  const { logger } = createLogger();

  const guardrail = createArbiterGuardrail({
    pluginConfig: pluginConfig(),
    logger,
    fetchImpl
  });

  const result = await guardrail.beforeToolCall(
    {
      toolName: "exec",
      params: { command: "ls -la /tmp" }
    },
    {
      agentId: "agent-4",
      sessionKey: "session-key-1"
    }
  );

  assert.equal(result, undefined);
  assert.equal(calls.length, 2);
});

test("afterToolCall records action state for protected tools", async () => {
  const { fetchImpl, calls } = createFetchSequence([jsonResponse(202, { status: "accepted" })]);
  const { logger } = createLogger();

  const guardrail = createArbiterGuardrail({
    pluginConfig: pluginConfig(),
    logger,
    fetchImpl
  });

  await guardrail.afterToolCall(
    {
      toolName: "apply_patch",
      params: { patch: "*** Begin Patch\n*** End Patch\n" }
    },
    {
      agentId: "agent-5",
      sessionId: "session-5"
    }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/state\/actions$/);
  const payload = parseCallBody(calls[0]);
  assert.equal(payload.tenant_id, "tenant-demo");
  assert.equal(payload.actor_id, "agent-5");
  assert.equal(payload.tool_name, "apply_patch");
  assert.equal(payload.outcome, "allowed");
  assert.equal(payload.session_id, "session-5");
});

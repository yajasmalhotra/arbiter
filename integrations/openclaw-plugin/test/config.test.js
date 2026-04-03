import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PROTECT_TOOLS, resolveActorId, resolvePluginConfig } from "../src/config.js";

test("resolvePluginConfig applies defaults and environment fallbacks", () => {
  const cfg = resolvePluginConfig(
    {},
    {
      ARBITER_URL: "http://localhost:8080/",
      ARBITER_TENANT_ID: "tenant-demo",
      ARBITER_GATEWAY_SHARED_KEY: "gw-key",
      ARBITER_SERVICE_SHARED_KEY: "svc-key"
    }
  );

  assert.equal(cfg.arbiterUrl, "http://localhost:8080");
  assert.equal(cfg.tenantId, "tenant-demo");
  assert.equal(cfg.gatewayKey, "gw-key");
  assert.equal(cfg.serviceKey, "svc-key");
  assert.deepEqual(cfg.protectTools, DEFAULT_PROTECT_TOOLS);
  assert.equal(cfg.recordState, true);
  assert.equal(cfg.failClosed, true);
  assert.equal(cfg.timeoutMs, 5000);
  assert.deepEqual(cfg.missing, []);
});

test("resolvePluginConfig reports missing required fields", () => {
  const cfg = resolvePluginConfig({}, {});
  assert.deepEqual(cfg.missing, ["arbiterUrl", "tenantId"]);
});

test("resolvePluginConfig requires actorId in config mode", () => {
  const cfg = resolvePluginConfig(
    {
      arbiterUrl: "http://localhost:8080",
      tenantId: "tenant-demo",
      actorIdMode: "config"
    },
    {}
  );
  assert.deepEqual(cfg.missing, ["actorId"]);
});

test("resolveActorId prefers context agent ID in agent-id mode", () => {
  const cfg = resolvePluginConfig(
    {
      arbiterUrl: "http://localhost:8080",
      tenantId: "tenant-demo",
      actorId: "fallback-actor"
    },
    {}
  );
  assert.equal(resolveActorId(cfg, { agentId: "agent-123" }), "agent-123");
  assert.equal(resolveActorId(cfg, {}), "fallback-actor");
});

test("resolveActorId uses configured value in config mode", () => {
  const cfg = resolvePluginConfig(
    {
      arbiterUrl: "http://localhost:8080",
      tenantId: "tenant-demo",
      actorIdMode: "config",
      actorId: "fixed-actor"
    },
    {}
  );
  assert.equal(resolveActorId(cfg, { agentId: "agent-123" }), "fixed-actor");
});

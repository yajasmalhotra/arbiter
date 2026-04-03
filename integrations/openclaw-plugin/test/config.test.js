import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PROTECT_TOOLS, resolveActorId, resolvePluginConfig } from "../src/config.js";

test("resolvePluginConfig applies defaults and local runtime fallbacks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-openclaw-test-"));
  const localConfigPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({
      base_url: "http://localhost:8080/",
      tenant_id: "tenant-demo"
    })
  );

  const cfg = resolvePluginConfig({ localConfigPath });

  assert.equal(cfg.arbiterUrl, "http://localhost:8080");
  assert.equal(cfg.tenantId, "tenant-demo");
  assert.equal(cfg.gatewayKey, "");
  assert.equal(cfg.serviceKey, "");
  assert.deepEqual(cfg.protectTools, DEFAULT_PROTECT_TOOLS);
  assert.equal(cfg.recordState, true);
  assert.equal(cfg.failClosed, true);
  assert.equal(cfg.timeoutMs, 5000);
  assert.deepEqual(cfg.missing, []);
});

test("resolvePluginConfig reports missing required fields", () => {
  const cfg = resolvePluginConfig({});
  assert.deepEqual(cfg.missing, ["arbiterUrl", "tenantId"]);
});

test("resolvePluginConfig requires actorId in config mode", () => {
  const cfg = resolvePluginConfig(
    {
      arbiterUrl: "http://localhost:8080",
      tenantId: "tenant-demo",
      actorIdMode: "config"
    }
  );
  assert.deepEqual(cfg.missing, ["actorId"]);
});

test("resolveActorId prefers context agent ID in agent-id mode", () => {
  const cfg = resolvePluginConfig(
    {
      arbiterUrl: "http://localhost:8080",
      tenantId: "tenant-demo",
      actorId: "fallback-actor"
    }
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
    }
  );
  assert.equal(resolveActorId(cfg, { agentId: "agent-123" }), "fixed-actor");
});

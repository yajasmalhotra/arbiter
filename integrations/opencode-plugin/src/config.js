import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PROTECTED_TOOLS = ["bash", "edit", "write", "apply_patch"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolean(value, fallback) {
  const normalized = text(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function timeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.min(60_000, Math.max(250, Math.round(parsed)));
}

function tools(value) {
  const configured = text(value);
  if (!configured) return DEFAULT_PROTECTED_TOOLS.slice();
  const values = configured.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : DEFAULT_PROTECTED_TOOLS.slice();
}

function localConfig(location) {
  const configPath = text(location) || path.join(os.homedir(), ".arbiter", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function baseURL(address) {
  const value = text(address);
  if (!value) return "";
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export function resolveOpenCodeConfig(env = process.env) {
  const local = localConfig(env.ARBITER_OPENCODE_LOCAL_CONFIG);
  const url = text(env.ARBITER_OPENCODE_URL) || text(env.ARBITER_URL) || text(local.base_url) || baseURL(local.address);
  const tenantId = text(env.ARBITER_OPENCODE_TENANT_ID) || text(env.ARBITER_TENANT_ID) || text(local.tenant_id);
  const actorId = text(env.ARBITER_OPENCODE_ACTOR_ID) || text(env.ARBITER_ACTOR_ID) || "opencode-agent";
  const protectedTools = tools(env.ARBITER_OPENCODE_PROTECT_TOOLS);
  const missing = [];
  if (!url) missing.push("ARBITER_OPENCODE_URL");
  if (!tenantId) missing.push("ARBITER_OPENCODE_TENANT_ID");

  return {
    url: url.replace(/\/$/, ""),
    tenantId,
    actorId,
    protectedTools,
    protectAll: protectedTools.includes("*"),
    failClosed: boolean(env.ARBITER_OPENCODE_FAIL_CLOSED, true),
    recordState: boolean(env.ARBITER_OPENCODE_RECORD_STATE, true),
    timeoutMs: timeout(env.ARBITER_OPENCODE_TIMEOUT_MS),
    bearerToken: text(env.ARBITER_OPENCODE_BEARER_TOKEN) || text(env.ARBITER_WORKLOAD_TOKEN),
    gatewayKey: text(env.ARBITER_GATEWAY_SHARED_KEY),
    serviceKey: text(env.ARBITER_SERVICE_SHARED_KEY),
    missing
  };
}

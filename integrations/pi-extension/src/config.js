import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PROTECTED_TOOLS = ["bash", "edit", "write"];
export const DEFAULT_TIMEOUT_MS = 5000;

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value, fallback) {
  const normalized = stringValue(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function timeoutValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(250, Math.round(parsed)));
}

function protectedTools(value) {
  const normalized = stringValue(value);
  if (!normalized) return DEFAULT_PROTECTED_TOOLS.slice();
  const tools = normalized.split(",").map((tool) => tool.trim()).filter(Boolean);
  return tools.length ? [...new Set(tools)] : DEFAULT_PROTECTED_TOOLS.slice();
}

function localRuntimeConfig(location) {
  const configPath = stringValue(location) || path.join(os.homedir(), ".arbiter", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function baseURL(address) {
  const value = stringValue(address);
  if (!value) return "";
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export function resolvePiConfig(env = process.env) {
  const local = localRuntimeConfig(env.ARBITER_PI_LOCAL_CONFIG);
  const url = stringValue(env.ARBITER_PI_URL) || stringValue(local.base_url) || baseURL(local.address);
  const tenantId = stringValue(env.ARBITER_PI_TENANT_ID) || stringValue(local.tenant_id);
  const actorId = stringValue(env.ARBITER_PI_ACTOR_ID) || "pi-agent";
  const tools = protectedTools(env.ARBITER_PI_PROTECT_TOOLS);
  const missing = [];
  if (!url) missing.push("ARBITER_PI_URL");
  if (!tenantId) missing.push("ARBITER_PI_TENANT_ID");

  return {
    url: url.replace(/\/$/, ""),
    tenantId,
    actorId,
    protectedTools: tools,
    protectAll: tools.includes("*"),
    failClosed: booleanValue(env.ARBITER_PI_FAIL_CLOSED, true),
    recordState: booleanValue(env.ARBITER_PI_RECORD_STATE, true),
    timeoutMs: timeoutValue(env.ARBITER_PI_TIMEOUT_MS),
    bearerToken: stringValue(env.ARBITER_PI_BEARER_TOKEN),
    gatewayKey: stringValue(env.ARBITER_GATEWAY_SHARED_KEY),
    serviceKey: stringValue(env.ARBITER_SERVICE_SHARED_KEY),
    missing
  };
}

export function sessionId(ctx) {
  const value = ctx?.sessionManager?.getSessionId?.();
  return stringValue(value);
}

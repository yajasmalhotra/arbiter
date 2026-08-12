import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PROTECTED_TOOLS = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit"];

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
  return Math.min(25_000, Math.max(250, Math.round(parsed)));
}

function protectedTools(value) {
  const configured = text(value);
  if (!configured) return DEFAULT_PROTECTED_TOOLS.slice();
  const tools = configured.split(",").map((tool) => tool.trim()).filter(Boolean);
  return tools.length ? [...new Set(tools)] : DEFAULT_PROTECTED_TOOLS.slice();
}

function localRuntimeConfig(location) {
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

export function resolveClaudeConfig(env = process.env) {
  const local = localRuntimeConfig(text(env.ARBITER_CLAUDE_LOCAL_CONFIG) || text(env.ARBITER_LOCAL_CONFIG));
  const url = text(env.ARBITER_CLAUDE_URL) || text(env.ARBITER_URL) || text(local.base_url) || baseURL(local.address);
  const tenantId = text(env.ARBITER_CLAUDE_TENANT_ID) || text(env.ARBITER_TENANT_ID) || text(local.tenant_id);
  const actorId = text(env.ARBITER_CLAUDE_ACTOR_ID) || text(env.ARBITER_ACTOR_ID) || "claude-code-agent";
  const tools = protectedTools(env.ARBITER_CLAUDE_PROTECT_TOOLS);
  const missing = [];
  if (!url) missing.push("ARBITER_CLAUDE_URL");
  if (!tenantId) missing.push("ARBITER_CLAUDE_TENANT_ID");

  return {
    url: url.replace(/\/$/, ""),
    tenantId,
    actorId,
    protectedTools: tools,
    protectAll: tools.includes("*"),
    failClosed: boolean(env.ARBITER_CLAUDE_FAIL_CLOSED, true),
    recordState: boolean(env.ARBITER_CLAUDE_RECORD_STATE, true),
    timeoutMs: timeout(env.ARBITER_CLAUDE_TIMEOUT_MS),
    bearerToken: text(env.ARBITER_CLAUDE_BEARER_TOKEN) || text(env.ARBITER_WORKLOAD_TOKEN),
    gatewayKey: text(env.ARBITER_GATEWAY_SHARED_KEY),
    serviceKey: text(env.ARBITER_SERVICE_SHARED_KEY),
    markerDir: text(env.ARBITER_CLAUDE_MARKER_DIR) || text(env.CLAUDE_PLUGIN_DATA) || path.join(os.tmpdir(), "arbiter-claude-code"),
    missing
  };
}

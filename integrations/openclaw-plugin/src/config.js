export const DEFAULT_PROTECT_TOOLS = ["exec", "process", "write", "edit", "apply_patch"];
export const DEFAULT_TIMEOUT_MS = 5000;

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function asTimeoutMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (value < 250) {
    return 250;
  }
  if (value > 60000) {
    return 60000;
  }
  return Math.round(value);
}

function normalizeToolList(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_PROTECT_TOOLS.slice();
  }
  const tools = value
    .map((entry) => asString(entry))
    .filter(Boolean);
  return tools.length > 0 ? Array.from(new Set(tools)) : DEFAULT_PROTECT_TOOLS.slice();
}

export function resolvePluginConfig(pluginConfig, env = process.env) {
  const cfg = asRecord(pluginConfig);
  const runtimeEnv = asRecord(env);

  const arbiterUrl = asString(cfg.arbiterUrl) || asString(runtimeEnv.ARBITER_URL);
  const tenantId = asString(cfg.tenantId) || asString(runtimeEnv.ARBITER_TENANT_ID);
  const gatewayKey = asString(cfg.gatewayKey) || asString(runtimeEnv.ARBITER_GATEWAY_SHARED_KEY);
  const serviceKey = asString(cfg.serviceKey) || asString(runtimeEnv.ARBITER_SERVICE_SHARED_KEY);
  const actorId = asString(cfg.actorId) || asString(runtimeEnv.ARBITER_ACTOR_ID);

  const actorIdMode = asString(cfg.actorIdMode) === "config" ? "config" : "agent-id";
  const protectTools = normalizeToolList(cfg.protectTools);
  const recordState = asBool(cfg.recordState, true);
  const failClosed = asBool(cfg.failClosed, true);
  const timeoutMs = asTimeoutMs(cfg.timeoutMs);

  const missing = [];
  if (!arbiterUrl) {
    missing.push("arbiterUrl");
  }
  if (!tenantId) {
    missing.push("tenantId");
  }
  if (actorIdMode === "config" && !actorId) {
    missing.push("actorId");
  }

  return {
    arbiterUrl: arbiterUrl.replace(/\/$/, ""),
    tenantId,
    gatewayKey,
    serviceKey,
    actorIdMode,
    actorId,
    protectTools,
    recordState,
    failClosed,
    timeoutMs,
    missing
  };
}

export function resolveActorId(config, ctx) {
  const hookCtx = asRecord(ctx);
  if (config.actorIdMode === "config") {
    return config.actorId;
  }
  return asString(hookCtx.agentId) || config.actorId || "openclaw-agent";
}

export function resolveSessionMetadata(ctx) {
  const hookCtx = asRecord(ctx);
  return {
    sessionId: asString(hookCtx.sessionId),
    sessionKey: asString(hookCtx.sessionKey)
  };
}

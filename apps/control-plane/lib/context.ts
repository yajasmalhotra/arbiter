export function defaultTenantId(): string {
  return (process.env.ARBITER_TENANT_ID ?? "default").trim() || "default";
}

export function defaultActor(): string {
  return (process.env.ARBITER_ACTOR ?? "control-plane").trim() || "control-plane";
}

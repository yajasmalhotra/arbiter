import { AsyncLocalStorage } from "node:async_hooks";

export type ControlPlaneRequestContext = {
  tenantId: string;
  actor: string;
  roles: string[];
};

const requestContext = new AsyncLocalStorage<ControlPlaneRequestContext | undefined>();

// API authentication establishes this context before the store is used. The
// store deliberately reads it rather than trusting a tenant or actor supplied
// in a mutation body. AsyncLocalStorage keeps concurrent Next.js requests
// isolated without threading tenant parameters through every store method.
export function setControlPlaneRequestContext(context: ControlPlaneRequestContext): void {
  requestContext.enterWith(context);
}

export function runWithControlPlaneRequestContext<T>(context: ControlPlaneRequestContext, operation: () => T): T {
  return requestContext.run(context, operation);
}

export function clearControlPlaneRequestContext(): void {
  requestContext.enterWith(undefined);
}

export function currentControlPlaneRequestContext(): ControlPlaneRequestContext | undefined {
  return requestContext.getStore();
}

export function defaultTenantId(): string {
  return requestContext.getStore()?.tenantId ?? ((process.env.ARBITER_TENANT_ID ?? "default").trim() || "default");
}

export function defaultActor(): string {
  return requestContext.getStore()?.actor ?? ((process.env.ARBITER_ACTOR ?? "control-plane").trim() || "control-plane");
}

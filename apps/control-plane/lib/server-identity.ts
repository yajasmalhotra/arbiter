import { cookies } from "next/headers";

import { CONTROL_PLANE_IDENTITY_COOKIE } from "./control-plane-headers";
import { authenticateControlPlaneIdentity, controlPlaneIdentityEnabled } from "./control-plane-identity";
import type { ControlPlaneRequestContext } from "./context";

// Server-rendered pages do not receive a browser's Authorization header.
// The dashboard writes the already-issued signed token to a same-site cookie,
// then this function verifies it before a page touches the tenant-scoped store.
export async function establishControlPlanePageContext(): Promise<ControlPlaneRequestContext | undefined> {
  if (!controlPlaneIdentityEnabled()) {
    return { tenantId: (process.env.ARBITER_TENANT_ID ?? "default").trim() || "default", actor: (process.env.ARBITER_ACTOR ?? "control-plane").trim() || "control-plane", roles: [] };
  }
  const token = (await cookies()).get(CONTROL_PLANE_IDENTITY_COOKIE)?.value;
  const identity = await authenticateControlPlaneIdentity(token);
  if (!identity) {
    return undefined;
  }
  return { tenantId: identity.tenantId, actor: identity.subject, roles: identity.roles };
}

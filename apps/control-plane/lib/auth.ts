import { NextRequest, NextResponse } from "next/server";

import { validateServiceToken } from "./store";
import {
  CONTROL_PLANE_AUTH_HEADER,
  CONTROL_PLANE_ROLE_HEADER,
  CONTROL_PLANE_TENANT_HEADER
} from "./control-plane-headers";
import { authenticateControlPlaneIdentity, controlPlaneIdentityEnabled } from "./control-plane-identity";
import { clearControlPlaneRequestContext, currentControlPlaneRequestContext, setControlPlaneRequestContext, type ControlPlaneRequestContext } from "./context";

export { CONTROL_PLANE_AUTH_HEADER, CONTROL_PLANE_TENANT_HEADER, CONTROL_PLANE_ROLE_HEADER };

export type ControlPlaneRole = "viewer" | "editor" | "approver" | "admin";

const ROLE_WEIGHT: Record<ControlPlaneRole, number> = {
  viewer: 10,
  editor: 20,
  approver: 30,
  admin: 40
};
const authenticatedContexts = new WeakMap<NextRequest, ControlPlaneRequestContext>();
const bundleServiceContexts = new WeakMap<NextRequest, ControlPlaneRequestContext>();

function parseBool(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function rbacEnabled(): boolean {
  return parseBool(process.env.ARBITER_CONTROL_PLANE_ENFORCE_RBAC);
}

function normalizeRole(raw: string | undefined): ControlPlaneRole | undefined {
  if (!raw) {
    return undefined;
  }
  const role = raw.trim().toLowerCase();
  if (role === "viewer" || role === "editor" || role === "approver" || role === "admin") {
    return role;
  }
  return undefined;
}

function currentRole(request: NextRequest): ControlPlaneRole | undefined {
  const trustedRoles = authenticatedContexts.get(request)?.roles ?? currentControlPlaneRequestContext()?.roles;
  if (trustedRoles?.length) {
    return trustedRoles.reduce<ControlPlaneRole>((highest, role) => ROLE_WEIGHT[role as ControlPlaneRole] > ROLE_WEIGHT[highest] ? role as ControlPlaneRole : highest, "viewer");
  }
  return normalizeRole(
    request.headers.get(CONTROL_PLANE_ROLE_HEADER) ??
      process.env.ARBITER_CONTROL_PLANE_DEFAULT_ROLE ??
      undefined
  );
}

export async function requireControlPlaneAuth(request: NextRequest): Promise<NextResponse | undefined> {
  clearControlPlaneRequestContext();
  if (controlPlaneIdentityEnabled()) {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const identity = await authenticateControlPlaneIdentity(token);
    if (!identity) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    authenticatedContexts.set(request, { tenantId: identity.tenantId, actor: identity.subject, roles: identity.roles });
    return requireControlPlaneTenant(request);
  }

  if (rbacEnabled() && !(process.env.CONTROL_PLANE_API_KEY ?? "").trim()) {
    return NextResponse.json({ error: "RBAC requires signed identity or CONTROL_PLANE_API_KEY" }, { status: 503 });
  }
  const expected = process.env.CONTROL_PLANE_API_KEY?.trim();
  if (!expected) {
    return requireControlPlaneTenant(request);
  }

  if (request.headers.get(CONTROL_PLANE_AUTH_HEADER) !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return requireControlPlaneTenant(request);
}

export function requireControlPlaneTenant(request: NextRequest): NextResponse | undefined {
  const trustedTenant = authenticatedContexts.get(request)?.tenantId ?? currentControlPlaneRequestContext()?.tenantId;
  if (trustedTenant) {
    const supplied = request.headers.get(CONTROL_PLANE_TENANT_HEADER)?.trim();
    if (supplied && supplied !== trustedTenant) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const allowedTenant = process.env.ARBITER_TENANT_ID?.trim();
    if (allowedTenant && allowedTenant !== trustedTenant) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return undefined;
  }
  const expectedTenant = process.env.ARBITER_TENANT_ID?.trim();
  if (!expectedTenant) {
    return undefined;
  }

  const tenant = request.headers.get(CONTROL_PLANE_TENANT_HEADER)?.trim();
  if (!tenant) {
    return NextResponse.json({ error: "missing tenant header" }, { status: 403 });
  }

  if (tenant !== expectedTenant) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return undefined;
}

// Authentication may await an OIDC JWKS fetch, so its AsyncLocalStorage scope
// cannot safely escape into the caller. Routes adopt this already-verified
// context in their own async continuation before accessing the store.
export function adoptControlPlaneRequestContext(request: NextRequest): void {
  const context = authenticatedContexts.get(request) ?? bundleServiceContexts.get(request);
  if (context) {
    setControlPlaneRequestContext(context);
  }
}

export async function requireControlPlaneRole(
  request: NextRequest,
  minimumRole: ControlPlaneRole
): Promise<NextResponse | undefined> {
  const unauthorized = await requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  if (!rbacEnabled() && !controlPlaneIdentityEnabled()) {
    return undefined;
  }

  const role = currentRole(request);
  if (!role) {
    return NextResponse.json(
      { error: `missing or invalid role; set ${CONTROL_PLANE_ROLE_HEADER}` },
      { status: 403 }
    );
  }

  if (ROLE_WEIGHT[role] < ROLE_WEIGHT[minimumRole]) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return undefined;
}

export async function requireBundleServiceAuth(
  request: NextRequest,
  requiredScope = "bundle:read"
): Promise<NextResponse | undefined> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const validated = await validateServiceToken(token, requiredScope);
  if (!validated) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  bundleServiceContexts.set(request, { tenantId: validated.tenantId, actor: `service-token:${validated.id}`, roles: [] });

  return undefined;
}

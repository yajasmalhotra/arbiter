import { NextRequest, NextResponse } from "next/server";

import { validateServiceToken } from "./store";
import {
  CONTROL_PLANE_AUTH_HEADER,
  CONTROL_PLANE_ROLE_HEADER,
  CONTROL_PLANE_TENANT_HEADER
} from "./control-plane-headers";

export { CONTROL_PLANE_AUTH_HEADER, CONTROL_PLANE_TENANT_HEADER, CONTROL_PLANE_ROLE_HEADER };

export type ControlPlaneRole = "viewer" | "editor" | "approver" | "admin";

const ROLE_WEIGHT: Record<ControlPlaneRole, number> = {
  viewer: 10,
  editor: 20,
  approver: 30,
  admin: 40
};

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
  return normalizeRole(
    request.headers.get(CONTROL_PLANE_ROLE_HEADER) ??
      process.env.ARBITER_CONTROL_PLANE_DEFAULT_ROLE ??
      undefined
  );
}

export function requireControlPlaneAuth(request: NextRequest): NextResponse | undefined {
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

export function requireControlPlaneRole(
  request: NextRequest,
  minimumRole: ControlPlaneRole
): NextResponse | undefined {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  if (!rbacEnabled()) {
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

  return undefined;
}

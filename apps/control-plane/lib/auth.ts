import { NextRequest, NextResponse } from "next/server";

import { validateServiceToken } from "./store";

export const CONTROL_PLANE_AUTH_HEADER = "X-Arbiter-Control-Key";
export const CONTROL_PLANE_TENANT_HEADER = "X-Arbiter-Tenant-ID";

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

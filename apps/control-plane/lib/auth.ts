import { NextRequest, NextResponse } from "next/server";

export const CONTROL_PLANE_AUTH_HEADER = "X-Arbiter-Control-Key";

export function requireControlPlaneAuth(request: NextRequest): NextResponse | undefined {
  const expected = process.env.CONTROL_PLANE_API_KEY?.trim();
  if (!expected) {
    return undefined;
  }

  if (request.headers.get(CONTROL_PLANE_AUTH_HEADER) !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return undefined;
}

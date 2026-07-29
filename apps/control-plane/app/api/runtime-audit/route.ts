import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listRuntimeDecisionEvents } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "10");
  const decisions = await listRuntimeDecisionEvents(rawLimit);
  return NextResponse.json({ decisions });
}

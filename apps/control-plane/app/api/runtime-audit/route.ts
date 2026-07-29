import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listRuntimeDecisionEvents } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const outcome = request.nextUrl.searchParams.get("outcome");
  const decisions = await listRuntimeDecisionEvents({
    limit: Number(request.nextUrl.searchParams.get("limit") ?? "10"),
    outcome: outcome === "allow" || outcome === "deny" ? outcome : undefined,
    toolName: request.nextUrl.searchParams.get("tool") ?? undefined,
    identifier: request.nextUrl.searchParams.get("id") ?? undefined,
    before: request.nextUrl.searchParams.get("before") ?? undefined,
    beforeId: request.nextUrl.searchParams.get("before_id") ?? undefined
  });
  return NextResponse.json({ decisions });
}

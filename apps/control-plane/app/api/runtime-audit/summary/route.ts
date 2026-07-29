import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../../lib/auth";
import { getRuntimeDecisionSummary } from "../../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const summary = await getRuntimeDecisionSummary(Number(request.nextUrl.searchParams.get("hours") ?? "24"));
  return NextResponse.json({ summary });
}

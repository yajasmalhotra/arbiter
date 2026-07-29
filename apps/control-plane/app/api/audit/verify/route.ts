import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../../lib/auth";
import { verifyAuditIntegrity } from "../../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  return NextResponse.json({ integrity: await verifyAuditIntegrity() });
}

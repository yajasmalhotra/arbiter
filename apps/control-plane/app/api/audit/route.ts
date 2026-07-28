import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listAuditEvents } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const auditEvents = await listAuditEvents();
  return NextResponse.json({ auditEvents });
}

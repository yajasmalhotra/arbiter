import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listApprovalRequests } from "../../../lib/store";
import type { ApprovalState } from "../../../lib/types";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);

  const rawState = request.nextUrl.searchParams.get("state")?.trim().toLowerCase() ?? "";
  const state =
    rawState === "pending" || rawState === "approved" || rawState === "rejected"
      ? (rawState as ApprovalState)
      : undefined;

  const approvalRequests = await listApprovalRequests(state);
  return NextResponse.json({ approvalRequests });
}

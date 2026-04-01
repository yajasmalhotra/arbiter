import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../../../lib/auth";
import { approveApprovalRequest } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  let body: { actor?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await approveApprovalRequest(id, {
      actor: typeof body.actor === "string" ? body.actor : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined
    });
    if (!result) {
      return NextResponse.json({ error: "approval request not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to approve request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

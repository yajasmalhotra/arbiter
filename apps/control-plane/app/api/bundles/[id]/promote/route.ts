import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../../../lib/auth";
import { createApprovalRequest, promoteBundle } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { actor?: string; notes?: string; channel?: "dev" | "staging" | "prod" };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const channel = body.channel ?? "prod";
  const unauthorized = requireControlPlaneRole(request, "editor");
  if (unauthorized) {
    return unauthorized;
  }

  try {
    if (channel === "prod") {
      const approvalRequest = await createApprovalRequest({
        action: "promote_bundle",
        channel: "prod",
        bundleId: id,
        actor: typeof body.actor === "string" ? body.actor : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined
      });
      return NextResponse.json(
        {
          status: "pending_approval",
          approvalRequest
        },
        { status: 202 }
      );
    }

    const bundle = await promoteBundle(id, channel, {
      actor: typeof body.actor === "string" ? body.actor : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined
    });
    if (!bundle) {
      return NextResponse.json({ error: "bundle not found" }, { status: 404 });
    }
    return NextResponse.json({ bundle });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to promote bundle";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

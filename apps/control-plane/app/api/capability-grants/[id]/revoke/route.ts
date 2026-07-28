import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../../../lib/auth";
import { revokeCapabilityGrant } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }
  const { id } = await params;
  let actor: string | undefined;
  try {
    const body = (await request.json()) as { actor?: unknown };
    actor = typeof body.actor === "string" ? body.actor : undefined;
  } catch {
    // Optional body.
  }
  try {
    const capabilityGrant = await revokeCapabilityGrant(id, actor);
    if (!capabilityGrant) {
      return NextResponse.json({ error: "capability grant not found" }, { status: 404 });
    }
    return NextResponse.json({ capabilityGrant });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to revoke capability grant" }, { status: 400 });
  }
}

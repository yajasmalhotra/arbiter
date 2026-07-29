import { NextRequest, NextResponse } from "next/server";

import {
  adoptControlPlaneRequestContext,
  requireControlPlaneRole
} from "../../../../../../lib/auth";
import { deletePolicyTestScenario } from "../../../../../../lib/store";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; scenarioId: string }> }
) {
  const unauthorized = await requireControlPlaneRole(request, "editor");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);

  const { id, scenarioId } = await params;
  const deleted = await deletePolicyTestScenario(id, scenarioId);
  if (!deleted) {
    return NextResponse.json({ error: "scenario not found" }, { status: 404 });
  }
  return NextResponse.json({ status: "deleted" });
}

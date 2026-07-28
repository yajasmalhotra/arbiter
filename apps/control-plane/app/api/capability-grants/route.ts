import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { createCapabilityGrant, listCapabilityGrants } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);
  return NextResponse.json({ capabilityGrants: await listCapabilityGrants() });
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Validation below returns a useful error.
  }
  try {
    const created = await createCapabilityGrant({
      name: typeof body.name === "string" ? body.name : "",
      subject: typeof body.subject === "string" ? body.subject : "",
      workloadId: typeof body.workloadId === "string" ? body.workloadId : undefined,
      serverIds: Array.isArray(body.serverIds) ? body.serverIds.map(String) : [],
      toolNames: Array.isArray(body.toolNames) ? body.toolNames.map(String) : [],
      maxAmountCents: typeof body.maxAmountCents === "number" ? body.maxAmountCents : undefined,
      mayDelegate: Boolean(body.mayDelegate),
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
      actor: typeof body.actor === "string" ? body.actor : undefined
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to create capability grant" }, { status: 400 });
  }
}

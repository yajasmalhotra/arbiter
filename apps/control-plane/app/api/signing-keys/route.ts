import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../lib/auth";
import { createSigningKey, listSigningKeys } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }

  const signingKeys = await listSigningKeys();
  return NextResponse.json({ signingKeys });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }

  let body: {
    name?: string;
    secret?: string;
    keyId?: string;
    scope?: string;
    actor?: string;
    activate?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const signingKey = await createSigningKey({
      name: typeof body.name === "string" ? body.name : "",
      secret: typeof body.secret === "string" ? body.secret : "",
      keyId: typeof body.keyId === "string" ? body.keyId : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      actor: typeof body.actor === "string" ? body.actor : undefined,
      activate: Boolean(body.activate)
    });
    return NextResponse.json({ signingKey }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to create signing key";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

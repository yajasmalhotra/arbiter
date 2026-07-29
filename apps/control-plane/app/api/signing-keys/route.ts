import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { createSigningKey, listSigningKeys } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);

  const signingKeys = await listSigningKeys();
  return NextResponse.json({ signingKeys });
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "approver");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);

  let body: {
    name?: string;
    secret?: string;
    keyId?: string;
    scope?: string;
    algorithm?: "HS256" | "RS256";
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
      algorithm: body.algorithm === "HS256" || body.algorithm === "RS256" ? body.algorithm : undefined,
      actor: typeof body.actor === "string" ? body.actor : undefined,
      activate: Boolean(body.activate)
    });
    return NextResponse.json({ signingKey }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to create signing key";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

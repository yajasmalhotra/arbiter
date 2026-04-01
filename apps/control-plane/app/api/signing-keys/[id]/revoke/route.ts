import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../../lib/auth";
import { revokeSigningKey } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  let body: { actor?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const signingKey = await revokeSigningKey(id, {
      actor: typeof body.actor === "string" ? body.actor : undefined
    });
    if (!signingKey) {
      return NextResponse.json({ error: "signing key not found" }, { status: 404 });
    }
    return NextResponse.json({ signingKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to revoke signing key";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

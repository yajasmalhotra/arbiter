import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../lib/auth";
import { createServiceToken, listServiceTokens } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const serviceTokens = await listServiceTokens();
  return NextResponse.json({ serviceTokens });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  let body: { name?: string; scopes?: string[]; actor?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const created = await createServiceToken({
      name: typeof body.name === "string" ? body.name : "",
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
      actor: typeof body.actor === "string" ? body.actor : undefined
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to create service token";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

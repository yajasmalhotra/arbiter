import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../../lib/auth";
import { promoteBundle } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  let body: { actor?: string; notes?: string; channel?: "dev" | "staging" | "prod" };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const bundle = await promoteBundle(id, body.channel ?? "prod", {
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

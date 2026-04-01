import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../../lib/auth";
import { activateBundle } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
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

  const bundle = await activateBundle(id, {
    actor: typeof body.actor === "string" ? body.actor : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined
  });
  if (!bundle) {
    return NextResponse.json({ error: "bundle not found" }, { status: 404 });
  }
  return NextResponse.json({ bundle });
}

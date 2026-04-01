import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../../../lib/auth";
import { rollbackChannel } from "../../../../../../lib/store";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> }
) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { channel } = await params;
  if (channel !== "dev" && channel !== "staging" && channel !== "prod") {
    return NextResponse.json({ error: "invalid channel" }, { status: 400 });
  }
  let body: { actor?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const bundle = await rollbackChannel(channel, {
      actor: typeof body.actor === "string" ? body.actor : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined
    });
    if (!bundle) {
      return NextResponse.json({ error: "no previous bundle found for channel" }, { status: 404 });
    }
    return NextResponse.json({ bundle });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to rollback channel";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

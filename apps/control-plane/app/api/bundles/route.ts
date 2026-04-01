import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../lib/auth";
import { listBundles, publishBundle } from "../../../lib/store";
import type { RolloutState } from "../../../lib/types";

export async function GET() {
  const bundles = await listBundles();
  return NextResponse.json({ bundles });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  let body: {
    policyIds?: string[];
    data?: Record<string, unknown>;
    rolloutState?: RolloutState;
    actor?: string;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const bundle = await publishBundle({
      policyIds: Array.isArray(body.policyIds) ? body.policyIds.map(String) : undefined,
      data: body.data ?? {},
      rolloutState: body.rolloutState ?? "draft",
      actor: typeof body.actor === "string" ? body.actor : undefined
    });
    return NextResponse.json({ bundle }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to publish bundle";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

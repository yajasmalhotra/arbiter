import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listBundles, publishBundle } from "../../../lib/store";
import type { RolloutState } from "../../../lib/types";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const bundles = await listBundles();
  return NextResponse.json({ bundles });
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "editor");
  if (unauthorized) {
    return unauthorized;
  }
  adoptControlPlaneRequestContext(request);

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
    const rolloutState = body.rolloutState ?? "draft";
    if (!["draft", "shadow", "canary", "enforced", "rolled_back"].includes(rolloutState)) {
      return NextResponse.json({ error: "invalid rollout state" }, { status: 400 });
    }
    const bundle = await publishBundle({
      policyIds: Array.isArray(body.policyIds) ? body.policyIds.map(String) : undefined,
      data: body.data ?? {},
      rolloutState,
      actor: typeof body.actor === "string" ? body.actor : undefined
    });
    return NextResponse.json({ bundle }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to publish bundle";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

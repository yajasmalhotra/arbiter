import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../lib/auth";
import { listPolicies, upsertPolicy } from "../../../lib/store";
import type { RolloutState } from "../../../lib/types";

export async function GET() {
  const policies = await listPolicies();
  return NextResponse.json({ policies });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireControlPlaneRole(request, "editor");
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json();
  const required = ["id", "name", "packageName", "version", "rolloutState", "rules"] as const;
  for (const field of required) {
    if (!body[field]) {
      return NextResponse.json({ error: `missing field: ${field}` }, { status: 400 });
    }
  }

  const policy = await upsertPolicy({
    id: String(body.id),
    name: String(body.name),
    packageName: String(body.packageName),
    version: String(body.version),
    rolloutState: String(body.rolloutState) as RolloutState,
    rules: body.rules as Record<string, unknown>
  });

  return NextResponse.json({ policy }, { status: 201 });
}

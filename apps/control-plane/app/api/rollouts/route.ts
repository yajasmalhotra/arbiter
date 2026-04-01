import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneRole } from "../../../lib/auth";
import { listPolicies, setRolloutState } from "../../../lib/store";
import type { RolloutState } from "../../../lib/types";

export async function GET() {
  const policies = await listPolicies();
  return NextResponse.json({
    rollouts: policies.map((policy) => ({
      policyId: policy.id,
      name: policy.name,
      rolloutState: policy.rolloutState,
      version: policy.version
    }))
  });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireControlPlaneRole(request, "editor");
  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json();
  if (!body.policyId || !body.rolloutState) {
    return NextResponse.json({ error: "policyId and rolloutState are required" }, { status: 400 });
  }

  const policy = await setRolloutState(String(body.policyId), String(body.rolloutState) as RolloutState);
  if (!policy) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  return NextResponse.json({
    policy: {
      id: policy.id,
      rolloutState: policy.rolloutState,
      version: policy.version
    }
  });
}

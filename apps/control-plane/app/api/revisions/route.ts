import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../lib/auth";
import { listDataRevisions, listPolicyRevisions } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const [policyRevisions, dataRevisions] = await Promise.all([listPolicyRevisions(), listDataRevisions()]);
  return NextResponse.json({ policyRevisions, dataRevisions });
}

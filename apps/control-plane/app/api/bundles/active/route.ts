import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../../lib/auth";
import { getActiveBundle } from "../../../../lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const bundle = await getActiveBundle();
  if (!bundle) {
    return NextResponse.json({ error: "no active bundle" }, { status: 404 });
  }
  return NextResponse.json({ bundle });
}

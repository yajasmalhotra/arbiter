import { NextRequest, NextResponse } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "../../../../lib/auth";
import { getBundle } from "../../../../lib/store";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const { id } = await params;
  const bundle = await getBundle(id);
  if (!bundle) {
    return NextResponse.json({ error: "bundle not found" }, { status: 404 });
  }
  return NextResponse.json({ bundle });
}

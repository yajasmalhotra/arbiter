import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../../lib/auth";
import { revokeServiceToken } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  try {
    const serviceToken = await revokeServiceToken(id);
    if (!serviceToken) {
      return NextResponse.json({ error: "service token not found" }, { status: 404 });
    }
    return NextResponse.json({ serviceToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to revoke service token";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

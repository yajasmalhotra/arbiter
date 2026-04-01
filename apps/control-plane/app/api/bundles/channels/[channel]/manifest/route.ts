import { NextRequest, NextResponse } from "next/server";

import { requireBundleServiceAuth } from "../../../../../../lib/auth";
import { getChannelManifest } from "../../../../../../lib/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> }
) {
  const authError = await requireBundleServiceAuth(request, "bundle:read");
  if (authError) {
    return authError;
  }

  const { channel } = await params;
  if (channel !== "dev" && channel !== "staging" && channel !== "prod") {
    return NextResponse.json({ error: "invalid channel" }, { status: 400 });
  }
  const manifest = await getChannelManifest(channel);
  if (!manifest) {
    return NextResponse.json({ error: "manifest not found" }, { status: 404 });
  }
  return NextResponse.json({ manifest });
}

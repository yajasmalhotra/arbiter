import { NextRequest, NextResponse } from "next/server";

import { requireBundleServiceAuth } from "../../../../../lib/auth";
import { getBundleArchive } from "../../../../../lib/store";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireBundleServiceAuth(request, "bundle:read");
  if (authError) {
    return authError;
  }

  const { id } = await params;
  const archive = await getBundleArchive(id);
  if (!archive) {
    return NextResponse.json({ error: "bundle not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(archive.content), {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${archive.fileName}"`,
      "X-Arbiter-Bundle-Digest": archive.digest,
      "Cache-Control": "no-store"
    }
  });
}

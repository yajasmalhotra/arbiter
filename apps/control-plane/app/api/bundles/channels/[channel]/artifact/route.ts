import { NextRequest, NextResponse } from "next/server";

import { requireBundleServiceAuth } from "../../../../../../lib/auth";
import { getChannelArchive } from "../../../../../../lib/store";

function normalizeETag(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("W/")) {
    normalized = normalized.slice(2).trim();
  }
  if (normalized.startsWith("\"") && normalized.endsWith("\"") && normalized.length > 1) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

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

  const archive = await getChannelArchive(channel);
  if (!archive) {
    return NextResponse.json({ error: "bundle not found for channel" }, { status: 404 });
  }

  const etag = `"${archive.digest}"`;
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && normalizeETag(ifNoneMatch) === archive.digest) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "X-Arbiter-Bundle-Digest": archive.digest,
        "Cache-Control": "no-store"
      }
    });
  }

  return new NextResponse(new Uint8Array(archive.content), {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${archive.fileName}"`,
      "X-Arbiter-Bundle-Digest": archive.digest,
      ETag: etag,
      "Cache-Control": "no-store"
    }
  });
}

import { NextRequest, NextResponse } from "next/server";

import { getBundle } from "../../../../lib/store";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bundle = await getBundle(id);
  if (!bundle) {
    return NextResponse.json({ error: "bundle not found" }, { status: 404 });
  }
  return NextResponse.json({ bundle });
}

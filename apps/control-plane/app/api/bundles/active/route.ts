import { NextResponse } from "next/server";

import { getActiveBundle } from "../../../../lib/store";

export async function GET() {
  const bundle = await getActiveBundle();
  if (!bundle) {
    return NextResponse.json({ error: "no active bundle" }, { status: 404 });
  }
  return NextResponse.json({ bundle });
}

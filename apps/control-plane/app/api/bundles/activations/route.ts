import { NextResponse } from "next/server";

import { listBundleActivations } from "../../../../lib/store";

export async function GET() {
  const activations = await listBundleActivations();
  return NextResponse.json({ activations });
}

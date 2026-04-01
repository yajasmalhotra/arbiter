import { NextResponse } from "next/server";

import { listDataRevisions, listPolicyRevisions } from "../../../lib/store";

export async function GET() {
  const [policyRevisions, dataRevisions] = await Promise.all([listPolicyRevisions(), listDataRevisions()]);
  return NextResponse.json({ policyRevisions, dataRevisions });
}

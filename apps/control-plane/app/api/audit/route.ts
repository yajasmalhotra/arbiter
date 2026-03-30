import { NextResponse } from "next/server";

import { listAuditEvents } from "../../../lib/store";

export async function GET() {
  const auditEvents = await listAuditEvents();
  return NextResponse.json({ auditEvents });
}

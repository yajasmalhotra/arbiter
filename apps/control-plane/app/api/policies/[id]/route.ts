import { NextRequest, NextResponse } from "next/server";

import { requireControlPlaneAuth } from "../../../../lib/auth";
import { deletePolicy, getPolicy, upsertPolicy } from "../../../../lib/store";
import type { RolloutState } from "../../../../lib/types";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getPolicy(id);
  if (!policy) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ policy });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  const body = await request.json();
  const existing = await getPolicy(id);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const policy = await upsertPolicy({
    id,
    name: String(body.name ?? existing.name),
    packageName: String(body.packageName ?? existing.packageName),
    version: String(body.version ?? existing.version),
    rolloutState: String(body.rolloutState ?? existing.rolloutState) as RolloutState,
    rules: (body.rules as Record<string, unknown>) ?? existing.rules
  });
  return NextResponse.json({ policy });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireControlPlaneAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { id } = await params;
  const deleted = await deletePolicy(id);
  if (!deleted) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ status: "deleted" });
}

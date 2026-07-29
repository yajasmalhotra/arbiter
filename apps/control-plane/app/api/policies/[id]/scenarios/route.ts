import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import {
  adoptControlPlaneRequestContext,
  requireControlPlaneRole
} from "../../../../../lib/auth";
import { defaultActor } from "../../../../../lib/context";
import {
  isPolicyTestInterceptPath,
  MAX_POLICY_TEST_PAYLOAD_BYTES,
  MAX_POLICY_TEST_SCENARIOS
} from "../../../../../lib/policy-validation";
import {
  createPolicyTestScenario,
  getPolicy,
  listPolicyTestScenarios
} from "../../../../../lib/store";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);

  const { id } = await params;
  if (!(await getPolicy(id))) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }
  return NextResponse.json({ scenarios: await listPolicyTestScenarios(id) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireControlPlaneRole(request, "editor");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);

  const { id } = await params;
  if (!(await getPolicy(id))) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    return NextResponse.json(
      { error: "name is required and must be at most 100 characters" },
      { status: 400 }
    );
  }
  if (!isPolicyTestInterceptPath(body.interceptPath)) {
    return NextResponse.json({ error: "unsupported interceptPath" }, { status: 400 });
  }
  if (body.expectedOutcome !== "allow" && body.expectedOutcome !== "deny") {
    return NextResponse.json({ error: "expectedOutcome must be allow or deny" }, { status: 400 });
  }
  if (body.payload === undefined || body.payload === null) {
    return NextResponse.json({ error: "payload is required" }, { status: 400 });
  }
  const serializedPayload = JSON.stringify(body.payload);
  if (Buffer.byteLength(serializedPayload, "utf8") > MAX_POLICY_TEST_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `payload exceeds ${MAX_POLICY_TEST_PAYLOAD_BYTES} bytes` },
      { status: 413 }
    );
  }

  const existing = await listPolicyTestScenarios(id);
  if (existing.length >= MAX_POLICY_TEST_SCENARIOS) {
    return NextResponse.json(
      { error: `a policy may have at most ${MAX_POLICY_TEST_SCENARIOS} scenarios` },
      { status: 409 }
    );
  }

  try {
    const scenario = await createPolicyTestScenario({
      policyId: id,
      name,
      interceptPath: body.interceptPath,
      payload: body.payload,
      expectedOutcome: body.expectedOutcome,
      createdBy: defaultActor()
    });
    return NextResponse.json({ scenario }, { status: 201 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "scenario creation failed";
    if (code === "23505" || message.includes("already exists")) {
      return NextResponse.json(
        { error: "a scenario with this name already exists" },
        { status: 409 }
      );
    }
    if (message.includes("scenario limit")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

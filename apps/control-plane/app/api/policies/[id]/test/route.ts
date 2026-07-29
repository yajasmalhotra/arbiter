import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import {
  adoptControlPlaneRequestContext,
  requireControlPlaneRole
} from "../../../../../lib/auth";
import {
  executePolicyValidation,
  isPolicyTestInterceptPath,
  MAX_POLICY_TEST_PAYLOAD_BYTES,
  type PolicyTestExpectation
} from "../../../../../lib/policy-validation";
import { getPolicy } from "../../../../../lib/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);
  const { id } = await params;
  const policy = await getPolicy(id);
  if (!policy) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  let body: { interceptPath?: string; payload?: unknown; arbiterBaseUrl?: string; expectedOutcome?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const interceptPath =
    isPolicyTestInterceptPath(body.interceptPath)
      ? body.interceptPath
      : "/v1/intercept/openai";

  if (body.payload === undefined || body.payload === null) {
    return NextResponse.json({ error: "payload is required" }, { status: 400 });
  }
  if (Buffer.byteLength(JSON.stringify(body.payload), "utf8") > MAX_POLICY_TEST_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `payload exceeds ${MAX_POLICY_TEST_PAYLOAD_BYTES} bytes` },
      { status: 413 }
    );
  }
  const expectedOutcome: PolicyTestExpectation | undefined =
    body.expectedOutcome === "allow" || body.expectedOutcome === "deny"
      ? body.expectedOutcome
      : undefined;
  if (body.expectedOutcome !== undefined && !expectedOutcome) {
    return NextResponse.json({ error: "expectedOutcome must be allow or deny" }, { status: 400 });
  }

  let baseUrl: string | undefined;
  if (typeof body.arbiterBaseUrl === "string" && body.arbiterBaseUrl.trim()) {
    if (process.env.NODE_ENV === "production" && process.env.ARBITER_ALLOW_TEST_URL_OVERRIDE !== "true") {
      return NextResponse.json({ error: "arbiterBaseUrl override is disabled in production" }, { status: 400 });
    }
    try {
      const u = new URL(body.arbiterBaseUrl.trim());
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
        return NextResponse.json(
          { error: "arbiterBaseUrl must be a credential-free http or https URL" },
          { status: 400 }
        );
      }
      baseUrl = u.origin;
    } catch {
      return NextResponse.json({ error: "invalid arbiterBaseUrl" }, { status: 400 });
    }
  }

  const execution = await executePolicyValidation({
    interceptPath,
    payload: body.payload,
    expectedOutcome,
    baseUrl,
    useServerCredentials: baseUrl === undefined
  });
  if (execution.error) {
    return NextResponse.json(
      {
        policyId: policy.id,
        request: {
          url: execution.url,
          interceptPath,
          durationMs: execution.durationMs
        },
        error: execution.error,
        hint: "Is Arbiter running? Set ARBITER_URL or enable the development URL override.",
        observedOutcome: execution.observedOutcome,
        assertion: execution.assertion
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    policyId: policy.id,
    policyName: policy.name,
    request: {
      url: execution.url,
      interceptPath,
      durationMs: execution.durationMs
    },
    arbiterStatus: execution.status,
    arbiterResponse: execution.response,
    observedOutcome: execution.observedOutcome,
    assertion: execution.assertion
  });
}

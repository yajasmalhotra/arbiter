import { NextRequest, NextResponse } from "next/server";

import {
  adoptControlPlaneRequestContext,
  requireControlPlaneRole
} from "../../../../../lib/auth";
import {
  classifyPolicyTestOutcome,
  policyTestAssertion,
  type PolicyTestExpectation
} from "../../../../../lib/policy-validation";
import { getPolicy } from "../../../../../lib/store";

const DEFAULT_ARBITER = "http://127.0.0.1:8080";
const ALLOWED_PATHS = new Set([
  "/v1/intercept/openai",
  "/v1/intercept/openai/stream",
  "/v1/intercept/anthropic",
  "/v1/intercept/framework/generic",
  "/v1/intercept/framework/langchain"
]);

function arbiterBase(): string {
  const raw = process.env.ARBITER_URL?.trim();
  if (!raw) {
    return DEFAULT_ARBITER;
  }
  return raw.replace(/\/$/, "");
}

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
    typeof body.interceptPath === "string" && ALLOWED_PATHS.has(body.interceptPath)
      ? body.interceptPath
      : "/v1/intercept/openai";

  if (body.payload === undefined || body.payload === null) {
    return NextResponse.json({ error: "payload is required" }, { status: 400 });
  }
  const expectedOutcome: PolicyTestExpectation | undefined =
    body.expectedOutcome === "allow" || body.expectedOutcome === "deny"
      ? body.expectedOutcome
      : undefined;
  if (body.expectedOutcome !== undefined && !expectedOutcome) {
    return NextResponse.json({ error: "expectedOutcome must be allow or deny" }, { status: 400 });
  }

  let base = arbiterBase();
  let useServerCredentials = true;
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
      base = u.origin;
      useServerCredentials = false;
    } catch {
      return NextResponse.json({ error: "invalid arbiterBaseUrl" }, { status: 400 });
    }
  }

  const url = `${base}${interceptPath}`;
  const started = Date.now();
  try {
    const gatewayKey = useServerCredentials
      ? process.env.ARBITER_POLICY_TEST_GATEWAY_KEY?.trim()
      : undefined;
    const bearerToken = useServerCredentials
      ? process.env.ARBITER_POLICY_TEST_BEARER_TOKEN?.trim()
      : undefined;
    const authorization = bearerToken
      ? bearerToken.toLowerCase().startsWith("bearer ")
        ? bearerToken
        : `Bearer ${bearerToken}`
      : undefined;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(gatewayKey ? { "X-Arbiter-Gateway-Key": gatewayKey } : {}),
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: JSON.stringify(body.payload),
      cache: "no-store"
    });
    const text = await upstream.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const observedOutcome = classifyPolicyTestOutcome(upstream.status, parsed);
    return NextResponse.json({
      policyId: policy.id,
      policyName: policy.name,
      request: { url, interceptPath, durationMs: Date.now() - started },
      arbiterStatus: upstream.status,
      arbiterResponse: parsed,
      observedOutcome,
      assertion: policyTestAssertion(expectedOutcome, observedOutcome)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    return NextResponse.json(
      {
        policyId: policy.id,
        request: { url, interceptPath, durationMs: Date.now() - started },
        error: message,
        hint: "Is Arbiter running? Set ARBITER_URL or enable the development URL override.",
        observedOutcome: "error",
        assertion: policyTestAssertion(expectedOutcome, "error")
      },
      { status: 502 }
    );
  }
}

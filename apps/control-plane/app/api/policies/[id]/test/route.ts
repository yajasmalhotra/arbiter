import { NextRequest, NextResponse } from "next/server";

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
  const { id } = await params;
  const policy = await getPolicy(id);
  if (!policy) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  let body: { interceptPath?: string; payload?: unknown; arbiterBaseUrl?: string };
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

  let base = arbiterBase();
  if (typeof body.arbiterBaseUrl === "string" && body.arbiterBaseUrl.trim()) {
    try {
      const u = new URL(body.arbiterBaseUrl.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return NextResponse.json({ error: "arbiterBaseUrl must be http or https" }, { status: 400 });
      }
      base = u.origin;
    } catch {
      return NextResponse.json({ error: "invalid arbiterBaseUrl" }, { status: 400 });
    }
  }

  const url = `${base}${interceptPath}`;
  const started = Date.now();
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    return NextResponse.json({
      policyId: policy.id,
      policyName: policy.name,
      request: { url, interceptPath, durationMs: Date.now() - started },
      arbiterStatus: upstream.status,
      arbiterResponse: parsed
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    return NextResponse.json(
      {
        policyId: policy.id,
        request: { url, interceptPath, durationMs: Date.now() - started },
        error: message,
        hint: "Is Arbiter running? Set ARBITER_URL or pass arbiterBaseUrl in the request body."
      },
      { status: 502 }
    );
  }
}

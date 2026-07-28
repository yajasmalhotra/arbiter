import { createHmac, generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { adoptControlPlaneRequestContext, requireControlPlaneRole } from "./auth";
import { clearControlPlaneRequestContext, defaultActor, defaultTenantId } from "./context";
import { resetOIDCCacheForTests } from "./control-plane-identity";

const trackedEnvironment = [
  "ARBITER_CONTROL_PLANE_JWT_SECRET",
  "ARBITER_CONTROL_PLANE_JWT_ISSUER",
  "ARBITER_CONTROL_PLANE_JWT_AUDIENCE",
  "ARBITER_CONTROL_PLANE_OIDC_JWKS_URL",
  "ARBITER_CONTROL_PLANE_OIDC_ISSUER",
  "ARBITER_CONTROL_PLANE_OIDC_AUDIENCE",
  "ARBITER_CONTROL_PLANE_OIDC_JWKS_CACHE_TTL_MS",
  "ARBITER_CONTROL_PLANE_ENFORCE_RBAC",
  "CONTROL_PLANE_API_KEY",
  "ARBITER_TENANT_ID"
] as const;
const originalEnvironment = Object.fromEntries(trackedEnvironment.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function signedToken(claims: Record<string, unknown>, secret = "test-secret"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function request(token: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://arbiter.test/api/policies", { headers: { authorization: `Bearer ${token}`, ...headers } });
}

function oidcToken(claims: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], kid = "test-key"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearControlPlaneRequestContext();
  resetOIDCCacheForTests();
  globalThis.fetch = originalFetch;
});

describe("control-plane signed identity", () => {
  it("uses signed tenant, subject, and role instead of client-controlled headers", async () => {
    process.env.ARBITER_CONTROL_PLANE_JWT_SECRET = "test-secret";
    process.env.ARBITER_CONTROL_PLANE_JWT_ISSUER = "issuer";
    process.env.ARBITER_CONTROL_PLANE_JWT_AUDIENCE = "arbiter-control-plane";
    const token = signedToken({ sub: "alice", tenant_id: "tenant-a", roles: ["editor"], iss: "issuer", aud: "arbiter-control-plane", exp: Math.floor(Date.now() / 1000) + 60 });

    const authenticatedRequest = request(token, { "X-Arbiter-Role": "admin", "X-Arbiter-Tenant-ID": "tenant-a" });
    const result = await requireControlPlaneRole(authenticatedRequest, "editor");
    expect(result).toBeUndefined();
    adoptControlPlaneRequestContext(authenticatedRequest);
    expect(defaultTenantId()).toBe("tenant-a");
    expect(defaultActor()).toBe("alice");

    const elevated = await requireControlPlaneRole(request(token, { "X-Arbiter-Role": "admin" }), "admin");
    expect(elevated?.status).toBe(403);
  });

  it("rejects expired or tenant-mismatched signed identity", async () => {
    process.env.ARBITER_CONTROL_PLANE_JWT_SECRET = "test-secret";
    const expired = signedToken({ sub: "alice", tenant_id: "tenant-a", roles: ["admin"], aud: "arbiter-control-plane", exp: Math.floor(Date.now() / 1000) - 1 });
    expect((await requireControlPlaneRole(request(expired), "viewer"))?.status).toBe(401);

    const valid = signedToken({ sub: "alice", tenant_id: "tenant-a", roles: ["admin"], aud: "arbiter-control-plane", exp: Math.floor(Date.now() / 1000) + 60 });
    expect((await requireControlPlaneRole(request(valid, { "X-Arbiter-Tenant-ID": "tenant-b" }), "viewer"))?.status).toBe(403);
  });

  it("fails closed when header RBAC has no server-side authentication", async () => {
    process.env.ARBITER_CONTROL_PLANE_ENFORCE_RBAC = "true";
    delete process.env.ARBITER_CONTROL_PLANE_JWT_SECRET;
    delete process.env.CONTROL_PLANE_API_KEY;

    expect((await requireControlPlaneRole(new NextRequest("http://arbiter.test/api/policies", { headers: { "X-Arbiter-Role": "admin" } }), "admin"))?.status).toBe(503);
  });

  it("validates RS256 OIDC tokens from a cached JWKS", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    process.env.ARBITER_CONTROL_PLANE_OIDC_JWKS_URL = "https://issuer.test/keys";
    process.env.ARBITER_CONTROL_PLANE_OIDC_ISSUER = "https://issuer.test";
    process.env.ARBITER_CONTROL_PLANE_OIDC_AUDIENCE = "arbiter-control-plane";
    delete process.env.ARBITER_CONTROL_PLANE_JWT_SECRET;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const token = oidcToken({ sub: "oidc-alice", tenant_id: "tenant-oidc", roles: ["approver"], iss: "https://issuer.test", aud: "arbiter-control-plane", exp: Math.floor(Date.now() / 1000) + 60 }, privateKey);

    const authenticatedRequest = request(token);
    expect(await requireControlPlaneRole(authenticatedRequest, "approver")).toBeUndefined();
    adoptControlPlaneRequestContext(authenticatedRequest);
    expect(defaultTenantId()).toBe("tenant-oidc");
    expect(await requireControlPlaneRole(request(token), "viewer")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

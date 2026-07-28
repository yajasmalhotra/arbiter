import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

import type { ControlPlaneRole } from "./auth";

const ROLES = new Set<ControlPlaneRole>(["viewer", "editor", "approver", "admin"]);
const MAX_TOKEN_BYTES = 8192;
const MAX_JWKS_BYTES = 1 << 20;

export type ControlPlaneIdentity = {
  subject: string;
  tenantId: string;
  roles: ControlPlaneRole[];
};

type TokenClaims = {
  sub?: unknown;
  tenant_id?: unknown;
  roles?: unknown;
  role?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

type ParsedToken = {
  header: Record<string, unknown>;
  claims: TokenClaims;
  signingInput: Buffer;
  signature: Buffer;
};

type JWKSCache = { keys: Map<string, KeyObject>; expiresAt: number };
let jwksCache: JWKSCache | undefined;

function base64urlJSON(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseToken(raw: string | undefined): ParsedToken | undefined {
  if (!raw || raw.length > MAX_TOKEN_BYTES) return undefined;
  const parts = raw.split(".");
  if (parts.length !== 3) return undefined;
  const header = base64urlJSON(parts[0]);
  const claims = base64urlJSON(parts[1]) as TokenClaims | undefined;
  if (!header || !claims) return undefined;
  try {
    return { header, claims, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], "base64url") };
  } catch {
    return undefined;
  }
}

function tokenRoles(claims: TokenClaims): ControlPlaneRole[] {
  const raw = claims.roles ?? claims.role;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter((value): value is ControlPlaneRole => ROLES.has(value as ControlPlaneRole)))];
}

function audienceMatches(raw: unknown, expected: string): boolean {
  if (!expected) return true;
  if (typeof raw === "string") return raw === expected;
  return Array.isArray(raw) && raw.some((value) => value === expected);
}

function validatedIdentity(claims: TokenClaims, issuer: string, audience: string): ControlPlaneIdentity | undefined {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.exp) || Number(claims.exp) <= now || (Number.isInteger(claims.nbf) && Number(claims.nbf) > now)) return undefined;
  if ((issuer && claims.iss !== issuer) || !audienceMatches(claims.aud, audience)) return undefined;
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id.trim() : "";
  const roles = tokenRoles(claims);
  return subject && tenantId && roles.length ? { subject, tenantId, roles } : undefined;
}

function verifyHMAC(token: ParsedToken, secret: string): boolean {
  if (token.header.alg !== "HS256") return false;
  const expected = createHmac("sha256", secret).update(token.signingInput).digest();
  return token.signature.length === expected.length && timingSafeEqual(token.signature, expected);
}

function oidcConfig(): { jwksURL: string; issuer: string; audience: string; cacheTTL: number } | undefined {
  const jwksURL = (process.env.ARBITER_CONTROL_PLANE_OIDC_JWKS_URL ?? "").trim();
  if (!jwksURL) return undefined;
  const issuer = (process.env.ARBITER_CONTROL_PLANE_OIDC_ISSUER ?? "").trim();
  const audience = (process.env.ARBITER_CONTROL_PLANE_OIDC_AUDIENCE ?? "arbiter-control-plane").trim();
  const rawTTL = Number(process.env.ARBITER_CONTROL_PLANE_OIDC_JWKS_CACHE_TTL_MS ?? 300_000);
  return { jwksURL, issuer, audience, cacheTTL: Number.isFinite(rawTTL) && rawTTL > 0 ? rawTTL : 300_000 };
}

async function oidcKeys(config: NonNullable<ReturnType<typeof oidcConfig>>): Promise<Map<string, KeyObject> | undefined> {
  if (jwksCache && Date.now() < jwksCache.expiresAt) return jwksCache.keys;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(config.jwksURL, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_JWKS_BYTES) return undefined;
    const document = JSON.parse(body.toString("utf8")) as { keys?: unknown };
    if (!Array.isArray(document.keys)) return undefined;
    const keys = new Map<string, KeyObject>();
    for (const raw of document.keys) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const key = raw as Record<string, unknown>;
      if (key.kty !== "RSA" || typeof key.kid !== "string" || !key.kid) continue;
      try {
        keys.set(key.kid, createPublicKey({ key: key as unknown as JsonWebKey, format: "jwk" }));
      } catch {
        // Invalid keys are ignored; a request without a verified matching key fails closed.
      }
    }
    if (!keys.size) return undefined;
    jwksCache = { keys, expiresAt: Date.now() + config.cacheTTL };
    return keys;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

// Authenticates control-plane operators either with a short-lived internal
// HS256 token or directly against an enterprise OIDC provider's RS256 JWKS.
// Both paths use the same mandatory tenant, role, issuer/audience, and expiry
// checks, so callers never trust browser-controlled tenant or role headers.
export async function authenticateControlPlaneIdentity(raw: string | undefined): Promise<ControlPlaneIdentity | undefined> {
  const token = parseToken(raw);
  if (!token) return undefined;

  const secret = (process.env.ARBITER_CONTROL_PLANE_JWT_SECRET ?? "").trim();
  if (secret) {
    if (!verifyHMAC(token, secret)) return undefined;
    return validatedIdentity(token.claims, (process.env.ARBITER_CONTROL_PLANE_JWT_ISSUER ?? "").trim(), (process.env.ARBITER_CONTROL_PLANE_JWT_AUDIENCE ?? "arbiter-control-plane").trim());
  }

  const config = oidcConfig();
  if (!config || token.header.alg !== "RS256" || typeof token.header.kid !== "string" || !token.header.kid) return undefined;
  const key = (await oidcKeys(config))?.get(token.header.kid);
  if (!key || !verifySignature("RSA-SHA256", token.signingInput, key, token.signature)) return undefined;
  return validatedIdentity(token.claims, config.issuer, config.audience);
}

export function controlPlaneIdentityEnabled(): boolean {
  return Boolean((process.env.ARBITER_CONTROL_PLANE_JWT_SECRET ?? "").trim() || oidcConfig());
}

export function resetOIDCCacheForTests(): void {
  jwksCache = undefined;
}

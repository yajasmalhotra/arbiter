import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign as signDetached
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { Pool, PoolClient } from "pg";
import tar from "tar-stream";

import { currentControlPlaneRequestContext, defaultActor, defaultTenantId } from "./context";
import { dbEnabled, ensureMigrations, getPool } from "./db";
import { MAX_POLICY_TEST_SCENARIOS } from "./policy-validation";
import * as legacy from "./store_legacy";
import type {
  ApprovalAction,
  ApprovalRequest,
  ApprovalState,
  AuditEvent,
  AuditIntegrityReport,
  BundleActivation,
  BundleArtifact,
  CapabilityGrant,
  DataRevision,
  PolicyRecord,
  PolicyRevision,
  PolicyTestScenario,
  RuntimeDecisionEvent,
  RuntimeDecisionSummary,
  RolloutState,
  SigningKey,
  ServiceToken
} from "./types";

const gzip = promisify(gzipCallback);
const CHANNELS = new Set(["dev", "staging", "prod"]);
const ROLLOUT_STATES = new Set<RolloutState>(["draft", "shadow", "canary", "enforced", "rolled_back"]);

type BundleChannel = "dev" | "staging" | "prod";

// Request-local signed identity always wins over a caller-supplied actor. The
// optional input remains for trusted server-side and legacy callers only.
export function authoritativeActor(candidate?: string): string {
  return currentControlPlaneRequestContext()?.actor ?? (candidate?.trim() || defaultActor());
}

function policyFromRow(row: Record<string, unknown>): PolicyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    packageName: String(row.package_name),
    version: String(row.version),
    rolloutState: String(row.rollout_state) as RolloutState,
    rules: asObject(row.rules),
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at)
  };
}

function policyTestScenarioFromRow(row: Record<string, unknown>): PolicyTestScenario {
  return {
    id: String(row.id),
    policyId: String(row.policy_id),
    name: String(row.name),
    interceptPath: String(row.intercept_path),
    payload: row.payload,
    expectedOutcome: String(row.expected_outcome) as PolicyTestScenario["expectedOutcome"],
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
    lastRunAt: row.last_run_at ? toISOString(row.last_run_at) : undefined,
    lastObservedOutcome: row.last_observed_outcome
      ? (String(row.last_observed_outcome) as PolicyTestScenario["lastObservedOutcome"])
      : undefined,
    lastPassed: row.last_passed === null || row.last_passed === undefined
      ? undefined
      : Boolean(row.last_passed),
    lastError: row.last_error ? String(row.last_error) : undefined
  };
}

function bundleFromRow(row: Record<string, unknown>): BundleArtifact {
  return {
    id: String(row.id),
    policyRevisionId: String(row.policy_revision_id),
    dataRevisionId: String(row.data_revision_id),
    rolloutState: String(row.rollout_state) as RolloutState,
    digest: String(row.digest),
    status: String(row.status) as BundleArtifact["status"],
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    snapshot: asObject(row.snapshot) as BundleArtifact["snapshot"]
  };
}

function serviceTokenFromRow(row: Record<string, unknown>): ServiceToken {
  return {
    id: String(row.id),
    name: String(row.name),
    scopes: normalizeScopes(row.scopes),
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    lastUsedAt: row.last_used_at ? toISOString(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? toISOString(row.revoked_at) : undefined
  };
}

function signingKeyFromRow(row: Record<string, unknown>): SigningKey {
  const algorithm = parseBundleSigningAlgorithm(row.algorithm);
  return {
    id: String(row.id),
    name: String(row.name),
    keyId: String(row.key_id),
    scope: String(row.scope),
    algorithm,
    isActive: Boolean(row.is_active),
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    activatedAt: row.activated_at ? toISOString(row.activated_at) : undefined,
    revokedAt: row.revoked_at ? toISOString(row.revoked_at) : undefined
  };
}

function capabilityGrantFromRow(row: Record<string, unknown>): CapabilityGrant {
  return {
    id: String(row.id),
    name: String(row.name),
    subject: String(row.subject),
    workloadId: row.workload_id ? String(row.workload_id) : undefined,
    serverIds: normalizeScopes(row.server_ids),
    toolNames: normalizeScopes(row.tool_names),
    maxAmountCents: row.max_amount_cents === null || row.max_amount_cents === undefined ? undefined : Number(row.max_amount_cents),
    mayDelegate: Boolean(row.may_delegate),
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    expiresAt: toISOString(row.expires_at),
    revokedAt: row.revoked_at ? toISOString(row.revoked_at) : undefined
  };
}

function approvalRequestFromRow(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    bundleId: String(row.bundle_id),
    action: String(row.action) as ApprovalAction,
    channel: String(row.channel) as BundleChannel,
    state: String(row.state) as ApprovalState,
    requestedBy: String(row.requested_by),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    reviewNotes: row.review_notes ? String(row.review_notes) : undefined,
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
    reviewedAt: row.reviewed_at ? toISOString(row.reviewed_at) : undefined
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
}

function asStringMap(value: unknown): Record<string, string> {
  const obj = asObject(value);
  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(obj)) {
    parsed[key] = String(raw);
  }
  return parsed;
}

function toISOString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

type AuditChainEvent = Pick<AuditEvent, "id" | "action" | "actor" | "policyId" | "at" | "metadata" | "previousHash" | "eventHash">;

// Hashes bind a tenant and the preceding event hash to every immutable audit
// payload. Stable serialization ensures Postgres JSONB key ordering cannot
// change the evidence after persistence.
export function auditEventHash(tenantID: string, event: Omit<AuditChainEvent, "eventHash">): string {
  return createHash("sha256").update(stableStringify({
    version: 1,
    tenant_id: tenantID,
    previous_hash: event.previousHash ?? null,
    id: event.id,
    action: event.action,
    actor: event.actor,
    policy_id: event.policyId ?? null,
    at: event.at,
    metadata: event.metadata ?? {}
  })).digest("hex");
}

export function verifyAuditChain(tenantID: string, events: AuditChainEvent[]): AuditIntegrityReport {
  let previousHash: string | undefined;
  let checkedEvents = 0;
  let unsealedLegacyEvents = 0;
  for (const event of events) {
    if (!event.eventHash) {
      unsealedLegacyEvents += 1;
      continue;
    }
    if (event.previousHash !== previousHash) {
      return { verified: false, checkedEvents, unsealedLegacyEvents, latestHash: previousHash, failure: `chain link mismatch at ${event.id}` };
    }
    const expected = auditEventHash(tenantID, event);
    if (event.eventHash !== expected) {
      return { verified: false, checkedEvents, unsealedLegacyEvents, latestHash: previousHash, failure: `event hash mismatch at ${event.id}` };
    }
    previousHash = event.eventHash;
    checkedEvents += 1;
  }
  return { verified: checkedEvents > 0, checkedEvents, unsealedLegacyEvents, latestHash: previousHash };
}

function bundleDigest(snapshot: BundleArtifact["snapshot"]): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

async function withDbOrFallback<T>(
  run: (db: Pool) => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  if (!dbEnabled()) {
    return fallback();
  }
  await ensureMigrations();
  const db = getPool();
  if (!db) {
    return fallback();
  }
  return run(db);
}

type PublishBundleInput = {
  policyIds?: string[];
  data?: Record<string, unknown>;
  rolloutState?: RolloutState;
  actor?: string;
};

type ActivateBundleInput = {
  actor?: string;
  notes?: string;
};

type PromoteBundleInput = {
  actor?: string;
  notes?: string;
};

type CreateApprovalRequestInput = {
  action: ApprovalAction;
  bundleId?: string;
  channel: BundleChannel;
  actor?: string;
  notes?: string;
};

type ReviewApprovalRequestInput = {
  actor?: string;
  notes?: string;
};

export function assertIndependentApprovalReviewer(
  request: Pick<ApprovalRequest, "channel" | "requestedBy">,
  reviewer: string
): void {
  if (request.channel === "prod" && request.requestedBy === reviewer) {
    throw new Error("production approval must be reviewed by a different actor than the requester");
  }
}

type BundleManifest = {
  channel: BundleChannel;
  bundleId: string;
  digest: string;
  policyRevisionId: string;
  dataRevisionId: string;
  rolloutState: RolloutState;
  enforcementMode: "enforce" | "shadow";
  artifactPath: string;
  signingKeyID: string;
  signingScope: string;
  signingAlgorithm: BundleSigningAlgorithm;
  generatedAt: string;
};

type ValidatedServiceToken = {
  id: string;
  name: string;
  scopes: string[];
  tenantId: string;
};

type BundleSigningAlgorithm = "HS256" | "RS256";

type BundleSigningConfig = {
  keyID: string;
  scope: string;
  secret?: string;
  algorithm: BundleSigningAlgorithm;
  externalSigner?: ExternalBundleSigner;
};

type ExternalBundleSigner = {
  url: string;
  token?: string;
  timeoutMs: number;
};

const SIGNING_KEY_ENCRYPTION_PREFIX = "arbiter-signing-key:v1";

function signingKeyEncryptionRequired(): boolean {
  const configured = process.env.ARBITER_REQUIRE_SIGNING_KEY_ENCRYPTION?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV === "production";
}

function signingKeyEncryptionKey(): Buffer | undefined {
  const encoded = process.env.ARBITER_SIGNING_KEY_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    if (signingKeyEncryptionRequired()) {
      throw new Error("ARBITER_SIGNING_KEY_ENCRYPTION_KEY is required when signing-key encryption is enforced");
    }
    return undefined;
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("ARBITER_SIGNING_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function signingKeyEncryptionAAD(tenantID: string, keyID: string): Buffer {
  return Buffer.from(`${SIGNING_KEY_ENCRYPTION_PREFIX}:${tenantID}:${keyID}`, "utf8");
}

export function encryptSigningKeySecret(secret: string, encryptionKey: Buffer, tenantID: string, keyID: string): string {
  if (encryptionKey.length !== 32) {
    throw new Error("signing-key encryption key must be 32 bytes");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(signingKeyEncryptionAAD(tenantID, keyID));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SIGNING_KEY_ENCRYPTION_PREFIX}:${toBase64URL(iv)}:${toBase64URL(tag)}:${toBase64URL(ciphertext)}`;
}

export function decryptSigningKeySecret(stored: string, encryptionKey: Buffer, tenantID: string, keyID: string): string {
  const parts = stored.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== SIGNING_KEY_ENCRYPTION_PREFIX) {
    throw new Error("invalid encrypted signing-key secret format");
  }
  if (encryptionKey.length !== 32) {
    throw new Error("signing-key encryption key must be 32 bytes");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, fromBase64URL(parts[2]));
    decipher.setAAD(signingKeyEncryptionAAD(tenantID, keyID));
    decipher.setAuthTag(fromBase64URL(parts[3]));
    return Buffer.concat([decipher.update(fromBase64URL(parts[4])), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("unable to decrypt signing key secret");
  }
}

function isEncryptedSigningKeySecret(value: string): boolean {
  return value.startsWith(`${SIGNING_KEY_ENCRYPTION_PREFIX}:`);
}

function storeSigningKeySecret(secret: string, tenantID: string, keyID: string): string {
  const encryptionKey = signingKeyEncryptionKey();
  return encryptionKey ? encryptSigningKeySecret(secret, encryptionKey, tenantID, keyID) : secret;
}

function loadSigningKeySecret(stored: string, tenantID: string, keyID: string): string {
  if (!isEncryptedSigningKeySecret(stored)) {
    if (signingKeyEncryptionRequired()) {
      throw new Error("unencrypted signing-key secret found while encryption is enforced; rotate this key");
    }
    return stored;
  }
  const encryptionKey = signingKeyEncryptionKey();
  if (!encryptionKey) {
    throw new Error("ARBITER_SIGNING_KEY_ENCRYPTION_KEY is required to decrypt the active signing key");
  }
  return decryptSigningKeySecret(stored, encryptionKey, tenantID, keyID);
}

function parseBundleSigningAlgorithm(value: unknown): BundleSigningAlgorithm {
  if (value === "HS256" || value === "RS256") {
    return value;
  }
  throw new Error("bundle signing algorithm must be HS256 or RS256");
}

function validateSigningSecret(algorithm: BundleSigningAlgorithm, secret: string): void {
  if (!secret) {
    throw new Error("bundle signing secret is required");
  }
  if (algorithm !== "RS256") {
    return;
  }

  try {
    const key = createPrivateKey(secret);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("not an RSA private key");
    }
  } catch {
    throw new Error("RS256 bundle signing secret must be a PEM-encoded RSA private key");
  }
}

function externalBundleSignerConfig(): ExternalBundleSigner | undefined {
  const rawURL = process.env.ARBITER_BUNDLE_SIGNER_URL?.trim();
  if (!rawURL) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw new Error("ARBITER_BUNDLE_SIGNER_URL must be an absolute URL");
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("ARBITER_BUNDLE_SIGNER_URL must use HTTPS in production");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("ARBITER_BUNDLE_SIGNER_URL must use HTTP or HTTPS");
  }
  const configuredTimeout = Number.parseInt(process.env.ARBITER_BUNDLE_SIGNER_TIMEOUT_MS ?? "3000", 10);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout < 100 || configuredTimeout > 30_000) {
    throw new Error("ARBITER_BUNDLE_SIGNER_TIMEOUT_MS must be between 100 and 30000 milliseconds");
  }
  return {
    url: url.toString(),
    token: process.env.ARBITER_BUNDLE_SIGNER_TOKEN?.trim() || undefined,
    timeoutMs: configuredTimeout
  };
}

function normalizeScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => String(entry).trim()).filter((scope) => scope.length > 0);
}

function parseScopesFromEnv(): string[] {
  const raw = process.env.ARBITER_BUNDLE_SERVICE_TOKEN_SCOPES ?? "bundle:read";
  return raw.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0);
}

function tokenHash(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function bundleSigningConfig(): BundleSigningConfig {
  const algorithm = parseBundleSigningAlgorithm((process.env.ARBITER_BUNDLE_SIGNING_ALGORITHM ?? "HS256").trim());
  const keyID = (process.env.ARBITER_BUNDLE_SIGNING_KEY_ID ?? `arbiter_bundle_${algorithm.toLowerCase()}`).trim();
  const scope = (process.env.ARBITER_BUNDLE_SIGNING_SCOPE ?? "read").trim();
  const externalSigner = externalBundleSignerConfig();
  if (externalSigner) {
    if (algorithm !== "RS256") {
      throw new Error("external bundle signing requires ARBITER_BUNDLE_SIGNING_ALGORITHM=RS256");
    }
    return {
      keyID: keyID || "arbiter_bundle_rs256",
      scope: scope || "read",
      algorithm,
      externalSigner
    };
  }
  const secret = (process.env.ARBITER_BUNDLE_SIGNING_SECRET ?? "dev-bundle-signing-secret").trim();
  validateSigningSecret(algorithm, secret);
  return {
    keyID: keyID || `arbiter_bundle_${algorithm.toLowerCase()}`,
    scope: scope || "read",
    secret,
    algorithm
  };
}

function policyRoot(): string {
  const configured = process.env.ARBITER_POLICY_ROOT?.trim();
  if (configured) {
    return configured;
  }
  return path.resolve(process.cwd(), "..", "..", "policy");
}

function missingPolicyTreeError(root: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : "unknown error";
  return new Error(
    `policy tree not found at ${root}: ${detail}. Set ARBITER_POLICY_ROOT or mount the repo policy directory into the control-plane container.`
  );
}

async function ensureBootstrapSigningKey(db: Pool): Promise<void> {
  const bootstrap = bundleSigningConfig();
  if (bootstrap.externalSigner) {
    return;
  }
  const now = new Date().toISOString();
  const tenantID = defaultTenantId();
  await db.query(
    `
      INSERT INTO signing_keys (
        id, tenant_id, name, key_id, scope, algorithm, secret, is_active, created_by, created_at, activated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $10)
      ON CONFLICT (tenant_id, key_id) DO NOTHING
    `,
    [
      "sk_bootstrap",
      tenantID,
      "bootstrap-bundle-signing-key",
      bootstrap.keyID,
      bootstrap.scope,
      bootstrap.algorithm,
      storeSigningKeySecret(bootstrap.secret ?? "", tenantID, bootstrap.keyID),
      defaultActor(),
      now,
      now
    ]
  );
}

async function resolveBundleSigningConfig(): Promise<BundleSigningConfig> {
  const fallback = bundleSigningConfig();
  if (fallback.externalSigner) {
    return fallback;
  }
  if (!dbEnabled()) {
    return fallback;
  }
  await ensureMigrations();
  const db = getPool();
  if (!db) {
    return fallback;
  }
  await ensureBootstrapSigningKey(db);
  const result = await db.query(
    `
      SELECT key_id, scope, algorithm, secret
      FROM signing_keys
      WHERE tenant_id = $1 AND is_active = TRUE AND revoked_at IS NULL
      LIMIT 1
    `,
    [defaultTenantId()]
  );
  if (!result.rowCount) {
    throw new Error("no active bundle signing key is available for this tenant");
  }
  const row = result.rows[0] as Record<string, unknown>;
  const keyID = String(row.key_id);
  return {
    keyID,
    scope: String(row.scope),
    secret: loadSigningKeySecret(String(row.secret), defaultTenantId(), keyID),
    algorithm: parseBundleSigningAlgorithm(row.algorithm)
  };
}

async function ensureBootstrapServiceToken(db: Pool): Promise<void> {
  const raw = (process.env.ARBITER_BUNDLE_SERVICE_TOKEN ?? "").trim();
  if (!raw) {
    return;
  }

  const now = new Date().toISOString();
  const scopes = parseScopesFromEnv();
  await db.query(
    `
      INSERT INTO service_tokens (
        id, tenant_id, name, token_hash, scopes, created_by, created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (token_hash) DO NOTHING
    `,
    [
      "st_bootstrap",
      defaultTenantId(),
      "bootstrap-bundle-reader",
      tokenHash(raw),
      JSON.stringify(scopes),
      defaultActor(),
      now
    ]
  );
}

function hasScope(scopes: string[], required: string): boolean {
  if (required.trim() === "") {
    return true;
  }
  return scopes.includes(required) || scopes.includes("*");
}

export async function validateServiceToken(
  rawToken: string,
  requiredScope: string
): Promise<ValidatedServiceToken | null> {
  const candidate = rawToken.trim();
  if (!candidate) {
    return null;
  }

  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapServiceToken(db);
      const result = await db.query(
        `
          SELECT id, name, tenant_id, scopes
          FROM service_tokens
          WHERE token_hash = $1 AND revoked_at IS NULL
          LIMIT 1
        `,
        [tokenHash(candidate)]
      );
      if (!result.rowCount) {
        return null;
      }

      const row = result.rows[0] as Record<string, unknown>;
      const scopes = normalizeScopes(row.scopes);
      if (!hasScope(scopes, requiredScope)) {
        return null;
      }

      await db.query("UPDATE service_tokens SET last_used_at = $1 WHERE id = $2", [
        new Date().toISOString(),
        String(row.id)
      ]);
      return {
        id: String(row.id),
        name: String(row.name),
        tenantId: String(row.tenant_id),
        scopes
      };
    },
    async () => {
      const bootstrap = (process.env.ARBITER_BUNDLE_SERVICE_TOKEN ?? "").trim();
      if (!bootstrap || bootstrap !== candidate) {
        return null;
      }
      const scopes = parseScopesFromEnv();
      if (!hasScope(scopes, requiredScope)) {
        return null;
      }
      return {
        id: "st_bootstrap",
        name: "bootstrap-bundle-reader",
        tenantId: defaultTenantId(),
        scopes
      };
    }
  );
}

type CreateServiceTokenInput = {
  name: string;
  scopes?: string[];
  actor?: string;
};

type CreateCapabilityGrantInput = {
  name: string;
  subject: string;
  workloadId?: string;
  serverIds: string[];
  toolNames: string[];
  maxAmountCents?: number;
  mayDelegate?: boolean;
  expiresAt: string;
  actor?: string;
};

export async function listServiceTokens(): Promise<ServiceToken[]> {
  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapServiceToken(db);
      const result = await db.query(
        `
          SELECT id, name, scopes, created_by, created_at, last_used_at, revoked_at
          FROM service_tokens
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => serviceTokenFromRow(row as Record<string, unknown>));
    },
    async () => []
  );
}

function generateServiceToken(id: string): string {
  return `${id}.${randomBytes(24).toString("base64url")}`;
}

export async function createServiceToken(
  input: CreateServiceTokenInput
): Promise<{ token: string; record: ServiceToken }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("service token name is required");
  }

  const normalizedScopes =
    input.scopes?.map((scope) => scope.trim()).filter((scope) => scope.length > 0) ?? ["bundle:read"];
  if (!normalizedScopes.length) {
    throw new Error("at least one scope is required");
  }

  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapServiceToken(db);
      const now = new Date().toISOString();
      const id = `st_${randomUUID()}`;
      const token = generateServiceToken(id);
      await db.query(
        `
          INSERT INTO service_tokens (
            id, tenant_id, name, token_hash, scopes, created_by, created_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        `,
        [
          id,
          defaultTenantId(),
          name,
          tokenHash(token),
          JSON.stringify(normalizedScopes),
          authoritativeActor(input.actor),
          now
        ]
      );
      const record: ServiceToken = {
        id,
        name,
        scopes: normalizedScopes,
        createdBy: authoritativeActor(input.actor),
        createdAt: now
      };
      return { token, record };
    },
    async () => {
      throw new Error("service token management requires ARBITER_DB_URL");
    }
  );
}

export async function revokeServiceToken(id: string): Promise<ServiceToken | undefined> {
  if (!id.trim()) {
    throw new Error("service token id is required");
  }

  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapServiceToken(db);
      const now = new Date().toISOString();
      const result = await db.query(
        `
          UPDATE service_tokens
          SET revoked_at = COALESCE(revoked_at, $1)
          WHERE tenant_id = $2 AND id = $3
          RETURNING id, name, scopes, created_by, created_at, last_used_at, revoked_at
        `,
        [now, defaultTenantId(), id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      return serviceTokenFromRow(result.rows[0] as Record<string, unknown>);
    },
    async () => {
      throw new Error("service token management requires ARBITER_DB_URL");
    }
  );
}

type CapabilitySigningConfig = {
  keyID: string;
  secret: string;
  algorithm: BundleSigningAlgorithm;
  issuer: string;
  audience: string;
};

function capabilitySigningConfig(): CapabilitySigningConfig {
  const algorithm = parseBundleSigningAlgorithm((process.env.ARBITER_CAPABILITY_ALGORITHM ?? "HS256").trim());
  const secret = (
    algorithm === "RS256"
      ? process.env.ARBITER_CAPABILITY_PRIVATE_KEY
      : process.env.ARBITER_CAPABILITY_SECRET
  )?.trim() ?? "";
  if (!secret) {
    throw new Error(
      algorithm === "RS256"
        ? "ARBITER_CAPABILITY_PRIVATE_KEY is required to issue RS256 capability grants"
        : "ARBITER_CAPABILITY_SECRET is required to issue capability grants"
    );
  }
  validateSigningSecret(algorithm, secret);
  return {
    keyID: (process.env.ARBITER_CAPABILITY_KID ?? "default").trim() || "default",
    secret,
    algorithm,
    issuer: (process.env.ARBITER_CAPABILITY_ISSUER ?? "arbiter").trim() || "arbiter",
    audience: (process.env.ARBITER_CAPABILITY_AUDIENCE ?? "arbiter-capability").trim() || "arbiter-capability"
  };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function signCapabilityGrant(grant: CapabilityGrant): string {
  const signing = capabilitySigningConfig();
  const header = base64url(JSON.stringify({ alg: signing.algorithm, typ: "JWT", kid: signing.keyID }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      grant_id: grant.id,
      tenant_id: defaultTenantId(),
      subject: grant.subject,
      workload_id: grant.workloadId,
      server_ids: grant.serverIds,
      tool_names: grant.toolNames,
      max_amount_cents: grant.maxAmountCents,
      may_delegate: grant.mayDelegate,
      iss: signing.issuer,
      aud: signing.audience,
      iat: now,
      nbf: now,
      exp: Math.floor(new Date(grant.expiresAt).getTime() / 1000),
      jti: `cap_${randomUUID()}`
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature =
    signing.algorithm === "HS256"
      ? createHmac("sha256", signing.secret).update(signingInput).digest("base64url")
      : signDetached("RSA-SHA256", Buffer.from(signingInput, "utf8"), signing.secret).toString("base64url");
  return `${signingInput}.${signature}`;
}

function capabilityRevocationEndpoints(): string[] {
  return (process.env.ARBITER_CAPABILITY_REVOCATION_ENDPOINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// Revocation is durable in Postgres first. Fan-out is deliberately best effort:
// a temporarily unreachable gateway must not turn a successful revocation into
// an apparent failure or leave the control-plane record ambiguous. Operators can
// replay the tiny id/expiry payload to a gateway's management endpoint.
async function synchronizeCapabilityRevocation(grant: CapabilityGrant): Promise<{ delivered: number; failed: number }> {
  const endpoints = capabilityRevocationEndpoints();
  const serviceKey = (process.env.ARBITER_SERVICE_SHARED_KEY ?? "").trim();
  if (!endpoints.length || !serviceKey) {
    return { delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed = 0;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Arbiter-Service-Key": serviceKey
        },
        body: JSON.stringify({ grant_id: grant.id, expires_at: grant.expiresAt }),
        signal: controller.signal
      });
      if (response.ok) {
        delivered += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { delivered, failed };
}

export async function listCapabilityGrants(): Promise<CapabilityGrant[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, name, subject, workload_id, server_ids, tool_names, max_amount_cents, may_delegate, created_by, created_at, expires_at, revoked_at
          FROM capability_grants
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => capabilityGrantFromRow(row as Record<string, unknown>));
    },
    async () => []
  );
}

export async function createCapabilityGrant(input: CreateCapabilityGrantInput): Promise<{ token: string; record: CapabilityGrant }> {
  const name = input.name.trim();
  const subject = input.subject.trim();
  const serverIds = input.serverIds.map((value) => value.trim()).filter(Boolean);
  const toolNames = input.toolNames.map((value) => value.trim()).filter(Boolean);
  const expiresAt = new Date(input.expiresAt);
  if (!name || !subject || !serverIds.length || !toolNames.length || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error("name, subject, serverIds, toolNames, and a future expiresAt are required");
  }
  if (input.maxAmountCents !== undefined && (!Number.isInteger(input.maxAmountCents) || input.maxAmountCents < 0)) {
    throw new Error("maxAmountCents must be a non-negative integer");
  }
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const record: CapabilityGrant = {
        id: `cg_${randomUUID()}`,
        name,
        subject,
        workloadId: input.workloadId?.trim() || undefined,
        serverIds,
        toolNames,
        maxAmountCents: input.maxAmountCents,
        mayDelegate: Boolean(input.mayDelegate),
        createdBy: authoritativeActor(input.actor),
        createdAt: now,
        expiresAt: expiresAt.toISOString()
      };
      await db.query(
        `
          INSERT INTO capability_grants (
            id, tenant_id, name, subject, workload_id, server_ids, tool_names, max_amount_cents, may_delegate, created_by, created_at, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
        `,
        [record.id, defaultTenantId(), record.name, record.subject, record.workloadId ?? null, JSON.stringify(record.serverIds), JSON.stringify(record.toolNames), record.maxAmountCents ?? null, record.mayDelegate, record.createdBy, record.createdAt, record.expiresAt]
      );
      await appendAuditEvent({ action: "capability_grant_created", actor: record.createdBy, metadata: { capabilityGrantId: record.id, subject: record.subject, serverIds: record.serverIds, toolNames: record.toolNames, expiresAt: record.expiresAt } });
      return { token: signCapabilityGrant(record), record };
    },
    async () => {
      throw new Error("capability grant management requires ARBITER_DB_URL");
    }
  );
}

export async function revokeCapabilityGrant(id: string, actor?: string): Promise<CapabilityGrant | undefined> {
  if (!id.trim()) {
    throw new Error("capability grant id is required");
  }
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const result = await db.query(
        `
          UPDATE capability_grants
          SET revoked_at = COALESCE(revoked_at, $1)
          WHERE tenant_id = $2 AND id = $3
          RETURNING id, name, subject, workload_id, server_ids, tool_names, max_amount_cents, may_delegate, created_by, created_at, expires_at, revoked_at
        `,
        [now, defaultTenantId(), id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      const record = capabilityGrantFromRow(result.rows[0] as Record<string, unknown>);
      await appendAuditEvent({ action: "capability_grant_revoked", actor: authoritativeActor(actor), metadata: { capabilityGrantId: record.id, subject: record.subject } });
      const sync = await synchronizeCapabilityRevocation(record);
      if (sync.delivered || sync.failed) {
        await appendAuditEvent({
          action: sync.failed ? "capability_revocation_sync_partial" : "capability_revocation_synced",
          actor: authoritativeActor(actor),
          metadata: { capabilityGrantId: record.id, delivered: sync.delivered, failed: sync.failed }
        });
      }
      return record;
    },
    async () => {
      throw new Error("capability grant management requires ARBITER_DB_URL");
    }
  );
}

type CreateSigningKeyInput = {
  name: string;
  secret: string;
  keyId?: string;
  scope?: string;
  algorithm?: BundleSigningAlgorithm;
  actor?: string;
  activate?: boolean;
};

type SigningKeyMutationInput = {
  actor?: string;
};

export async function listSigningKeys(): Promise<SigningKey[]> {
  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapSigningKey(db);
      const result = await db.query(
        `
          SELECT id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
          FROM signing_keys
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => signingKeyFromRow(row as Record<string, unknown>));
    },
    async () => {
      const signing = bundleSigningConfig();
      const fallbackKey: SigningKey = {
        id: "sk_env",
        name: "env-bundle-signing-key",
        keyId: signing.keyID,
        scope: signing.scope,
        algorithm: signing.algorithm,
        isActive: true,
        createdBy: "env",
        createdAt: new Date(0).toISOString()
      };
      return [fallbackKey];
    }
  );
}

export async function createSigningKey(input: CreateSigningKeyInput): Promise<SigningKey> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("signing key name is required");
  }
  const secret = input.secret.trim();
  if (!secret) {
    throw new Error("signing key secret is required");
  }
  const keyId = input.keyId?.trim() || `skid_${randomUUID()}`;
  const scope = input.scope?.trim() || "read";
  const algorithm = parseBundleSigningAlgorithm(input.algorithm ?? "HS256");
  validateSigningSecret(algorithm, secret);
  const activate = Boolean(input.activate);
  const actor = authoritativeActor(input.actor);

  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapSigningKey(db);
      const id = `sk_${randomUUID()}`;
      const now = new Date().toISOString();
      const client = await db.connect();
      let created: SigningKey | undefined;
      try {
        await client.query("BEGIN");
        if (activate) {
          await client.query(
            `
              UPDATE signing_keys
              SET is_active = FALSE
              WHERE tenant_id = $1 AND revoked_at IS NULL
            `,
            [defaultTenantId()]
          );
        }
        const result = await client.query(
          `
            INSERT INTO signing_keys (
              id, tenant_id, name, key_id, scope, algorithm, secret, is_active, created_by, created_at, activated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
          `,
          [
            id,
            defaultTenantId(),
            name,
            keyId,
            scope,
            algorithm,
            storeSigningKeySecret(secret, defaultTenantId(), keyId),
            activate,
            actor,
            now,
            activate ? now : null
          ]
        );
        created = signingKeyFromRow(result.rows[0] as Record<string, unknown>);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      if (!created) {
        throw new Error("failed to create signing key");
      }
      await appendAuditEvent({
        action: activate ? "signing_key_created_and_activated" : "signing_key_created",
        actor,
        metadata: {
          signingKeyId: created.id,
          keyId: created.keyId,
          scope: created.scope,
          algorithm: created.algorithm
        }
      });
      return created;
    },
    async () => {
      throw new Error("signing key management requires ARBITER_DB_URL");
    }
  );
}

export async function activateSigningKey(
  id: string,
  input: SigningKeyMutationInput = {}
): Promise<SigningKey | undefined> {
  const candidate = id.trim();
  if (!candidate) {
    throw new Error("signing key id is required");
  }
  const actor = authoritativeActor(input.actor);
  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapSigningKey(db);
      const now = new Date().toISOString();
      const client = await db.connect();
      let activated: SigningKey | undefined;
      try {
        await client.query("BEGIN");
        const target = await client.query(
          `
            SELECT id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
            FROM signing_keys
            WHERE tenant_id = $1 AND id = $2
            LIMIT 1
          `,
          [defaultTenantId(), candidate]
        );
        if (!target.rowCount) {
          await client.query("COMMIT");
          return undefined;
        }
        const targetRow = target.rows[0] as Record<string, unknown>;
        if (targetRow.revoked_at) {
          throw new Error("cannot activate a revoked signing key");
        }

        await client.query(
          `
            UPDATE signing_keys
            SET is_active = FALSE
            WHERE tenant_id = $1 AND revoked_at IS NULL
          `,
          [defaultTenantId()]
        );
        const result = await client.query(
          `
            UPDATE signing_keys
            SET is_active = TRUE, activated_at = COALESCE(activated_at, $1)
            WHERE tenant_id = $2 AND id = $3
            RETURNING id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
          `,
          [now, defaultTenantId(), candidate]
        );
        activated = result.rowCount
          ? signingKeyFromRow(result.rows[0] as Record<string, unknown>)
          : undefined;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      if (activated) {
        await appendAuditEvent({
          action: "signing_key_activated",
          actor,
          metadata: {
            signingKeyId: activated.id,
            keyId: activated.keyId
          }
        });
      }
      return activated;
    },
    async () => {
      throw new Error("signing key management requires ARBITER_DB_URL");
    }
  );
}

export async function revokeSigningKey(
  id: string,
  input: SigningKeyMutationInput = {}
): Promise<SigningKey | undefined> {
  const candidate = id.trim();
  if (!candidate) {
    throw new Error("signing key id is required");
  }
  const actor = authoritativeActor(input.actor);
  return withDbOrFallback(
    async (db) => {
      await ensureBootstrapSigningKey(db);
      const now = new Date().toISOString();
      const client = await db.connect();
      let revoked: SigningKey | undefined;
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `
            UPDATE signing_keys
            SET revoked_at = COALESCE(revoked_at, $1), is_active = FALSE
            WHERE tenant_id = $2 AND id = $3
            RETURNING id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
          `,
          [now, defaultTenantId(), candidate]
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return undefined;
        }
        revoked = signingKeyFromRow(result.rows[0] as Record<string, unknown>);
        const activeCount = await client.query(
          `
            SELECT id
            FROM signing_keys
            WHERE tenant_id = $1 AND revoked_at IS NULL AND is_active = TRUE
            LIMIT 1
          `,
          [defaultTenantId()]
        );
        if (!activeCount.rowCount) {
          await client.query(
            `
              UPDATE signing_keys
              SET is_active = TRUE, activated_at = COALESCE(activated_at, $1)
              WHERE id = (
                SELECT id
                FROM signing_keys
                WHERE tenant_id = $2 AND revoked_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
              )
            `,
            [now, defaultTenantId()]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      if (revoked) {
        await appendAuditEvent({
          action: "signing_key_revoked",
          actor,
          metadata: {
            signingKeyId: revoked.id,
            keyId: revoked.keyId
          }
        });
      }
      return revoked;
    },
    async () => {
      throw new Error("signing key management requires ARBITER_DB_URL");
    }
  );
}

export async function listPolicies(): Promise<PolicyRecord[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, name, package_name, version, rollout_state, rules, created_at, updated_at
          FROM policies
          WHERE tenant_id = $1
          ORDER BY updated_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => policyFromRow(row as Record<string, unknown>));
    },
    async () => legacy.listPolicies()
  );
}

export async function getPolicy(id: string): Promise<PolicyRecord | undefined> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, name, package_name, version, rollout_state, rules, created_at, updated_at
          FROM policies
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        [defaultTenantId(), id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      return policyFromRow(result.rows[0] as Record<string, unknown>);
    },
    async () => legacy.getPolicy(id)
  );
}

export async function listPolicyTestScenarios(policyId: string): Promise<PolicyTestScenario[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, policy_id, name, intercept_path, payload, expected_outcome,
                 created_by, created_at, updated_at, last_run_at,
                 last_observed_outcome, last_passed, last_error
          FROM policy_test_scenarios
          WHERE tenant_id = $1 AND policy_id = $2
          ORDER BY updated_at DESC
        `,
        [defaultTenantId(), policyId]
      );
      return result.rows.map((row) =>
        policyTestScenarioFromRow(row as Record<string, unknown>)
      );
    },
    async () => legacy.listPolicyTestScenarios(policyId)
  );
}

export async function createPolicyTestScenario(
  input: Omit<
    PolicyTestScenario,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "lastRunAt"
    | "lastObservedOutcome"
    | "lastPassed"
    | "lastError"
  >
): Promise<PolicyTestScenario> {
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const tenantID = defaultTenantId();
      const actor = authoritativeActor(input.createdBy);
      const client = await db.connect();
      let scenario: PolicyTestScenario;
      try {
        await client.query("BEGIN");
        const policy = await client.query(
          "SELECT 1 FROM policies WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [tenantID, input.policyId]
        );
        if (!policy.rowCount) {
          throw new Error("policy not found");
        }
        const count = await client.query(
          "SELECT COUNT(*)::int AS count FROM policy_test_scenarios WHERE tenant_id = $1 AND policy_id = $2",
          [tenantID, input.policyId]
        );
        if (Number(count.rows[0]?.count ?? 0) >= MAX_POLICY_TEST_SCENARIOS) {
          throw new Error(`scenario limit of ${MAX_POLICY_TEST_SCENARIOS} reached`);
        }
        const result = await client.query(
          `
            INSERT INTO policy_test_scenarios (
              id, tenant_id, policy_id, name, intercept_path, payload,
              expected_outcome, created_by, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)
            RETURNING id, policy_id, name, intercept_path, payload, expected_outcome,
                      created_by, created_at, updated_at, last_run_at,
                      last_observed_outcome, last_passed, last_error
          `,
          [
            randomUUID(),
            tenantID,
            input.policyId,
            input.name,
            input.interceptPath,
            JSON.stringify(input.payload),
            input.expectedOutcome,
            actor,
            now
          ]
        );
        scenario = policyTestScenarioFromRow(result.rows[0] as Record<string, unknown>);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await appendAuditEvent({
        action: "policy_test_scenario_created",
        actor,
        policyId: input.policyId,
        metadata: {
          scenarioId: scenario.id,
          expectedOutcome: scenario.expectedOutcome,
          interceptPath: scenario.interceptPath
        }
      });
      return scenario;
    },
    async () => {
      const scenario = await legacy.createPolicyTestScenario({
        ...input,
        createdBy: authoritativeActor(input.createdBy)
      });
      await legacy.appendAuditEvent({
        action: "policy_test_scenario_created",
        actor: authoritativeActor(input.createdBy),
        policyId: input.policyId,
        metadata: {
          scenarioId: scenario.id,
          expectedOutcome: scenario.expectedOutcome,
          interceptPath: scenario.interceptPath
        }
      });
      return scenario;
    }
  );
}

export async function deletePolicyTestScenario(
  policyId: string,
  scenarioId: string
): Promise<boolean> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          DELETE FROM policy_test_scenarios
          WHERE tenant_id = $1 AND policy_id = $2 AND id = $3
        `,
        [defaultTenantId(), policyId, scenarioId]
      );
      if (!result.rowCount) return false;
      await appendAuditEvent({
        action: "policy_test_scenario_deleted",
        actor: defaultActor(),
        policyId,
        metadata: { scenarioId }
      });
      return true;
    },
    async () => {
      const deleted = await legacy.deletePolicyTestScenario(policyId, scenarioId);
      if (deleted) {
        await legacy.appendAuditEvent({
          action: "policy_test_scenario_deleted",
          actor: defaultActor(),
          policyId,
          metadata: { scenarioId }
        });
      }
      return deleted;
    }
  );
}

export async function recordPolicyTestScenarioResults(
  policyId: string,
  results: Array<{
    scenarioId: string;
    observedOutcome: NonNullable<PolicyTestScenario["lastObservedOutcome"]>;
    passed: boolean;
    error?: string;
  }>
): Promise<void> {
  return withDbOrFallback(
    async (db) => {
      if (!results.length) return;
      const now = new Date().toISOString();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const result of results) {
          await client.query(
            `
              UPDATE policy_test_scenarios
              SET last_run_at = $1,
                  last_observed_outcome = $2,
                  last_passed = $3,
                  last_error = $4,
                  updated_at = $1
              WHERE tenant_id = $5 AND policy_id = $6 AND id = $7
            `,
            [
              now,
              result.observedOutcome,
              result.passed,
              result.error ?? null,
              defaultTenantId(),
              policyId,
              result.scenarioId
            ]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async () => legacy.recordPolicyTestScenarioResults(policyId, results)
  );
}

export async function upsertPolicy(input: Omit<PolicyRecord, "createdAt" | "updatedAt">): Promise<PolicyRecord> {
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const result = await db.query(
        `
          INSERT INTO policies (
            id, tenant_id, name, package_name, version, rollout_state, rules, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
          ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              package_name = EXCLUDED.package_name,
              version = EXCLUDED.version,
              rollout_state = EXCLUDED.rollout_state,
              rules = EXCLUDED.rules,
              updated_at = EXCLUDED.updated_at
          RETURNING id, name, package_name, version, rollout_state, rules, created_at, updated_at
        `,
        [
          input.id,
          defaultTenantId(),
          input.name,
          input.packageName,
          input.version,
          input.rolloutState,
          JSON.stringify(input.rules ?? {}),
          now
        ]
      );

      const policy = policyFromRow(result.rows[0] as Record<string, unknown>);
      await appendAuditEvent({
        action: "policy_updated",
        actor: defaultActor(),
        policyId: policy.id,
        metadata: {
          rolloutState: policy.rolloutState
        }
      });
      return policy;
    },
    async () => legacy.upsertPolicy(input)
  );
}

export async function deletePolicy(id: string): Promise<boolean> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query("DELETE FROM policies WHERE tenant_id = $1 AND id = $2", [
        defaultTenantId(),
        id
      ]);
      if (!result.rowCount) {
        return false;
      }
      await appendAuditEvent({
        action: "policy_deleted",
        actor: defaultActor(),
        policyId: id
      });
      return true;
    },
    async () => legacy.deletePolicy(id)
  );
}

export async function setRolloutState(id: string, rolloutState: RolloutState): Promise<PolicyRecord | undefined> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          UPDATE policies
          SET rollout_state = $1, updated_at = $2
          WHERE tenant_id = $3 AND id = $4
          RETURNING id, name, package_name, version, rollout_state, rules, created_at, updated_at
        `,
        [rolloutState, new Date().toISOString(), defaultTenantId(), id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      const policy = policyFromRow(result.rows[0] as Record<string, unknown>);
      await appendAuditEvent({
        action: "rollout_state_changed",
        actor: defaultActor(),
        policyId: id,
        metadata: { rolloutState }
      });
      return policy;
    },
    async () => legacy.setRolloutState(id, rolloutState)
  );
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, action, actor, policy_id, at, metadata, previous_hash, event_hash
          FROM audit_events
          WHERE tenant_id = $1
          ORDER BY at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          action: String(record.action),
          actor: String(record.actor),
          policyId: record.policy_id ? String(record.policy_id) : undefined,
          at: toISOString(record.at),
          metadata: asObject(record.metadata),
          previousHash: record.previous_hash ? String(record.previous_hash) : undefined,
          eventHash: record.event_hash ? String(record.event_hash) : undefined
        };
      });
    },
    async () => legacy.listAuditEvents()
  );
}

function runtimeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asObject(value);
}

export function runtimeDecisionEventFromRow(row: Record<string, unknown>): RuntimeDecisionEvent {
  const metadata = runtimeMetadata(row.metadata);
  const latency = Number(metadata.latency_ms);
  return {
    id: String(row.id),
    at: toISOString(row.at),
    decisionId: typeof metadata.decision_id === "string" ? metadata.decision_id : undefined,
    requestId: typeof metadata.request_id === "string" ? metadata.request_id : undefined,
    traceId: typeof metadata.trace_id === "string" ? metadata.trace_id : undefined,
    toolName: typeof metadata.tool_name === "string" ? metadata.tool_name : undefined,
    allowed: typeof metadata.allow === "boolean" ? metadata.allow : undefined,
    policyAllowed: typeof metadata.policy_allow === "boolean" ? metadata.policy_allow : undefined,
    enforcementMode: typeof metadata.enforcement_mode === "string" ? metadata.enforcement_mode : undefined,
    reason: typeof metadata.reason === "string" ? metadata.reason : undefined,
    policyPackage: typeof metadata.policy_package === "string" ? metadata.policy_package : undefined,
    policyVersion: typeof metadata.policy_version === "string" ? metadata.policy_version : undefined,
    dataRevision: typeof metadata.data_revision === "string" ? metadata.data_revision : undefined,
    latencyMs: Number.isFinite(latency) ? latency : undefined
  };
}

export type RuntimeDecisionQuery = {
  limit?: number;
  outcome?: "allow" | "deny" | "would-deny";
  toolName?: string;
  identifier?: string;
  before?: string;
  beforeId?: string;
};

export type NormalizedRuntimeDecisionQuery = {
  limit: number;
  outcome?: "allow" | "deny" | "would-deny";
  toolName?: string;
  identifier?: string;
  before?: string;
  beforeId?: string;
};

function boundedQueryValue(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeRuntimeDecisionQuery(query: RuntimeDecisionQuery = {}): NormalizedRuntimeDecisionQuery {
  const limit = Math.max(1, Math.min(Math.floor(Number(query.limit)) || 10, 100));
  const outcome = query.outcome === "allow" || query.outcome === "deny" || query.outcome === "would-deny" ? query.outcome : undefined;
  const beforeDate = query.before ? new Date(query.before) : undefined;
  const before = beforeDate && Number.isFinite(beforeDate.getTime()) ? beforeDate.toISOString() : undefined;
  return {
    limit,
    outcome,
    toolName: boundedQueryValue(query.toolName, 128),
    identifier: boundedQueryValue(query.identifier, 128),
    before,
    beforeId: before ? boundedQueryValue(query.beforeId, 128) : undefined
  };
}

export async function listRuntimeDecisionEvents(query: RuntimeDecisionQuery = {}): Promise<RuntimeDecisionEvent[]> {
  const normalized = normalizeRuntimeDecisionQuery(query);
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, at, metadata
          FROM runtime_audit_events
          WHERE tenant_id = $1
            AND action = 'intercept_decision'
            AND (
              $2::text IS NULL
              OR ($2 = 'allow' AND metadata->>'allow' = 'true' AND COALESCE(metadata->>'policy_allow', 'true') = 'true')
              OR ($2 = 'deny' AND metadata->>'allow' = 'false')
              OR ($2 = 'would-deny' AND metadata->>'allow' = 'true' AND metadata->>'policy_allow' = 'false' AND metadata->>'enforcement_mode' = 'shadow')
            )
            AND ($3::text IS NULL OR metadata->>'tool_name' = $3)
            AND ($4::text IS NULL OR metadata->>'decision_id' = $4 OR metadata->>'request_id' = $4 OR metadata->>'trace_id' = $4)
            AND ($5::timestamptz IS NULL OR at < $5::timestamptz OR (at = $5::timestamptz AND ($6::text IS NULL OR id < $6)))
          ORDER BY at DESC, id DESC
          LIMIT $7
        `,
        [
          defaultTenantId(),
          normalized.outcome ?? null,
          normalized.toolName ?? null,
          normalized.identifier ?? null,
          normalized.before ?? null,
          normalized.beforeId ?? null,
          normalized.limit
        ]
      );
      return result.rows.map((row) => runtimeDecisionEventFromRow(row as Record<string, unknown>));
    },
    async () => []
  );
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function runtimeDecisionSummaryFromRows(
  counts: Record<string, unknown>,
  deniedToolRows: Array<Record<string, unknown>>,
  windowHours: number
): RuntimeDecisionSummary {
  const total = nonNegativeInteger(counts.total);
  const allowed = nonNegativeInteger(counts.allowed);
  const denied = nonNegativeInteger(counts.denied);
  const shadowDenied = nonNegativeInteger(counts.shadow_denied);
  const recorded = Math.max(0, total - allowed - denied);
  return {
    windowHours,
    total,
    allowed,
    denied,
    shadowDenied,
    recorded,
    denialRate: total > 0 ? denied / total : 0,
    policyDenialRate: total > 0 ? (denied + shadowDenied) / total : 0,
    topDeniedTools: deniedToolRows
      .map((row) => ({
        toolName: typeof row.tool_name === "string" && row.tool_name.trim() ? row.tool_name : "unknown",
        count: nonNegativeInteger(row.count)
      }))
      .filter((entry) => entry.count > 0)
  };
}

export async function getRuntimeDecisionSummary(windowHours = 24): Promise<RuntimeDecisionSummary> {
  const boundedWindow = Math.max(1, Math.min(Math.floor(Number(windowHours)) || 24, 24 * 30));
  const since = new Date(Date.now() - boundedWindow * 60 * 60 * 1000).toISOString();
  return withDbOrFallback(
    async (db) => {
      const [counts, deniedTools] = await Promise.all([
        db.query(
          `
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE metadata->>'allow' = 'true')::int AS allowed,
              COUNT(*) FILTER (WHERE metadata->>'allow' = 'false')::int AS denied,
              COUNT(*) FILTER (WHERE metadata->>'allow' = 'true' AND metadata->>'policy_allow' = 'false' AND metadata->>'enforcement_mode' = 'shadow')::int AS shadow_denied
            FROM runtime_audit_events
            WHERE tenant_id = $1 AND action = 'intercept_decision' AND at >= $2
          `,
          [defaultTenantId(), since]
        ),
        db.query(
          `
            SELECT COALESCE(NULLIF(metadata->>'tool_name', ''), 'unknown') AS tool_name, COUNT(*)::int AS count
            FROM runtime_audit_events
            WHERE tenant_id = $1 AND action = 'intercept_decision' AND metadata->>'allow' = 'false' AND at >= $2
            GROUP BY 1
            ORDER BY count DESC, tool_name ASC
            LIMIT 5
          `,
          [defaultTenantId(), since]
        )
      ]);
      return runtimeDecisionSummaryFromRows(
        (counts.rows[0] ?? {}) as Record<string, unknown>,
        deniedTools.rows as Array<Record<string, unknown>>,
        boundedWindow
      );
    },
    async () => runtimeDecisionSummaryFromRows({}, [], boundedWindow)
  );
}

export async function appendAuditEvent(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  return withDbOrFallback(
    async (db) => {
      const tenantID = defaultTenantId();
      const created: AuditEvent = {
        ...event,
        id: randomUUID(),
        at: new Date().toISOString()
      };
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantID]);
        const previous = await client.query(
          `SELECT event_hash FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`,
          [tenantID]
        );
        created.previousHash = previous.rowCount ? String((previous.rows[0] as Record<string, unknown>).event_hash) : undefined;
        created.eventHash = auditEventHash(tenantID, created);
        await client.query(
          `
            INSERT INTO audit_events (id, tenant_id, action, actor, policy_id, at, metadata, previous_hash, event_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
          `,
          [created.id, tenantID, created.action, created.actor, created.policyId ?? null, created.at, JSON.stringify(created.metadata ?? {}), created.previousHash ?? null, created.eventHash]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return created;
    },
    async () => legacy.appendAuditEvent(event)
  );
}

export async function verifyAuditIntegrity(): Promise<AuditIntegrityReport> {
  return withDbOrFallback(
    async (db) => {
      const tenantID = defaultTenantId();
      const result = await db.query(
        `SELECT id, action, actor, policy_id, at, metadata, previous_hash, event_hash FROM audit_events WHERE tenant_id = $1 ORDER BY at ASC, id ASC`,
        [tenantID]
      );
      return verifyAuditChain(tenantID, result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return { id: String(record.id), action: String(record.action), actor: String(record.actor), policyId: record.policy_id ? String(record.policy_id) : undefined, at: toISOString(record.at), metadata: asObject(record.metadata), previousHash: record.previous_hash ? String(record.previous_hash) : undefined, eventHash: record.event_hash ? String(record.event_hash) : undefined };
      }));
    },
    async (): Promise<AuditIntegrityReport> => ({ verified: false, checkedEvents: 0, unsealedLegacyEvents: (await legacy.listAuditEvents()).length, failure: "audit integrity verification requires Postgres" })
  );
}

export async function listBundles(): Promise<BundleArtifact[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
          FROM bundles
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => bundleFromRow(row as Record<string, unknown>));
    },
    async () => legacy.listBundles()
  );
}

export async function getBundle(id: string): Promise<BundleArtifact | undefined> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
          FROM bundles
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        [defaultTenantId(), id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      return bundleFromRow(result.rows[0] as Record<string, unknown>);
    },
    async () => legacy.getBundle(id)
  );
}

export async function getActiveBundle(): Promise<BundleArtifact | undefined> {
  return withDbOrFallback(
    async (db) => {
      const channelResult = await db.query(
        `
          SELECT b.id, b.policy_revision_id, b.data_revision_id, b.rollout_state, b.digest, b.status, b.created_by, b.created_at, b.snapshot
          FROM bundle_channels c
          JOIN bundles b ON b.id = c.bundle_id
          WHERE c.tenant_id = $1 AND c.channel = 'prod'
          LIMIT 1
        `,
        [defaultTenantId()]
      );
      if (channelResult.rowCount) {
        return bundleFromRow(channelResult.rows[0] as Record<string, unknown>);
      }

      const fallback = await db.query(
        `
          SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
          FROM bundles
          WHERE tenant_id = $1 AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [defaultTenantId()]
      );
      if (!fallback.rowCount) {
        return undefined;
      }
      return bundleFromRow(fallback.rows[0] as Record<string, unknown>);
    },
    async () => legacy.getActiveBundle()
  );
}

export async function listPolicyRevisions(): Promise<PolicyRevision[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, policy_ids, policy_versions, created_by, created_at
          FROM policy_revisions
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          policyIds: asArray(record.policy_ids).map((value) => String(value)),
          policyVersions: asStringMap(record.policy_versions),
          createdBy: String(record.created_by),
          createdAt: toISOString(record.created_at)
        };
      });
    },
    async () => legacy.listPolicyRevisions()
  );
}

export async function listDataRevisions(): Promise<DataRevision[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, data, created_by, created_at
          FROM data_revisions
          WHERE tenant_id = $1
          ORDER BY created_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          data: asObject(record.data),
          createdBy: String(record.created_by),
          createdAt: toISOString(record.created_at)
        };
      });
    },
    async () => legacy.listDataRevisions()
  );
}

export async function listBundleActivations(): Promise<BundleActivation[]> {
  return withDbOrFallback(
    async (db) => {
      const result = await db.query(
        `
          SELECT id, bundle_id, channel, state, activated_by, activated_at, notes
          FROM bundle_activations
          WHERE tenant_id = $1
          ORDER BY activated_at DESC
        `,
        [defaultTenantId()]
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          bundleId: String(record.bundle_id),
          channel: String(record.channel) as BundleChannel,
          state: String(record.state) as BundleActivation["state"],
          activatedBy: String(record.activated_by),
          activatedAt: toISOString(record.activated_at),
          notes: record.notes ? String(record.notes) : undefined
        };
      });
    },
    async () => {
      const activations = await legacy.listBundleActivations();
      return activations.map((activation) => ({
        ...activation,
        channel: (activation.channel ?? "prod") as BundleChannel
      }));
    }
  );
}

export async function publishBundle(input: PublishBundleInput = {}): Promise<BundleArtifact> {
  if (input.rolloutState && !ROLLOUT_STATES.has(input.rolloutState)) {
    throw new Error(`invalid rollout state: ${input.rolloutState}`);
  }
  const actor = authoritativeActor(input.actor);
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const tenant = defaultTenantId();

      const selectedPoliciesResult = input.policyIds?.length
        ? await db.query(
            `
              SELECT id, name, package_name, version, rollout_state, rules, created_at, updated_at
              FROM policies
              WHERE tenant_id = $1 AND id = ANY($2::text[])
              ORDER BY updated_at DESC
            `,
            [tenant, input.policyIds]
          )
        : await db.query(
            `
              SELECT id, name, package_name, version, rollout_state, rules, created_at, updated_at
              FROM policies
              WHERE tenant_id = $1
              ORDER BY updated_at DESC
            `,
            [tenant]
          );

      const selectedPolicies = selectedPoliciesResult.rows.map((row) => policyFromRow(row as Record<string, unknown>));

      const policyRevisionId = `pr_${randomUUID()}`;
      const dataRevisionId = `dr_${randomUUID()}`;
      const bundleId = `bundle_${randomUUID()}`;
      const snapshot: BundleArtifact["snapshot"] = {
        policies: selectedPolicies,
        data: input.data ?? {}
      };
      const bundle: BundleArtifact = {
        id: bundleId,
        policyRevisionId,
        dataRevisionId,
        rolloutState: input.rolloutState ?? "draft",
        digest: bundleDigest(snapshot),
        status: "published",
        createdBy: actor,
        createdAt: now,
        snapshot
      };

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            INSERT INTO policy_revisions (id, tenant_id, policy_ids, policy_versions, created_by, created_at)
            VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
          `,
          [
            policyRevisionId,
            tenant,
            JSON.stringify(selectedPolicies.map((policy) => policy.id)),
            JSON.stringify(Object.fromEntries(selectedPolicies.map((policy) => [policy.id, policy.version]))),
            actor,
            now
          ]
        );
        await client.query(
          `
            INSERT INTO data_revisions (id, tenant_id, data, created_by, created_at)
            VALUES ($1, $2, $3::jsonb, $4, $5)
          `,
          [dataRevisionId, tenant, JSON.stringify(input.data ?? {}), actor, now]
        );
        await client.query(
          `
            INSERT INTO bundles (
              id, tenant_id, policy_revision_id, data_revision_id,
              rollout_state, digest, status, created_by, created_at, snapshot
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          `,
          [
            bundle.id,
            tenant,
            bundle.policyRevisionId,
            bundle.dataRevisionId,
            bundle.rolloutState,
            bundle.digest,
            bundle.status,
            bundle.createdBy,
            bundle.createdAt,
            JSON.stringify(bundle.snapshot)
          ]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await appendAuditEvent({
        action: "bundle_published",
        actor,
        metadata: {
          bundleId: bundle.id,
          digest: bundle.digest,
          policyRevisionId: bundle.policyRevisionId,
          dataRevisionId: bundle.dataRevisionId,
          rolloutState: bundle.rolloutState
        }
      });

      return bundle;
    },
    async () => legacy.publishBundle({ ...input, actor })
  );
}

export async function activateBundle(id: string, input: ActivateBundleInput = {}): Promise<BundleArtifact | undefined> {
  return promoteBundle(id, "prod", input);
}

async function currentChannelBundleID(
  client: PoolClient,
  tenant: string,
  channel: BundleChannel
): Promise<string | undefined> {
  const channelResult = await client.query(
    `
      SELECT bundle_id
      FROM bundle_channels
      WHERE tenant_id = $1 AND channel = $2
      LIMIT 1
    `,
    [tenant, channel]
  );
  if (channelResult.rowCount) {
    return String((channelResult.rows[0] as Record<string, unknown>).bundle_id);
  }

  const fallback = await client.query(
    `
      SELECT id
      FROM bundles
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [tenant]
  );
  if (!fallback.rowCount) {
    return undefined;
  }
  return String((fallback.rows[0] as Record<string, unknown>).id);
}

async function promoteBundleTx(
  client: PoolClient,
  tenant: string,
  bundleID: string,
  channel: BundleChannel,
  actor: string,
  notes?: string
): Promise<BundleArtifact | undefined> {
  const now = new Date().toISOString();
  const targetResult = await client.query(
    `
      SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
      FROM bundles
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenant, bundleID]
  );
  if (!targetResult.rowCount) {
    return undefined;
  }

  const currentBundleID = await currentChannelBundleID(client, tenant, channel);
  if (currentBundleID && currentBundleID !== bundleID) {
    await client.query(
      "UPDATE bundles SET status = 'rolled_back' WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
      [tenant, currentBundleID]
    );
    await client.query(
      `
        INSERT INTO bundle_activations (
          id, tenant_id, bundle_id, channel, state, activated_by, activated_at, notes
        )
        VALUES ($1, $2, $3, $4, 'rolled_back', $5, $6, $7)
      `,
      [randomUUID(), tenant, currentBundleID, channel, actor, now, `superseded by ${bundleID}`]
    );
  }

  await client.query(
    `
      INSERT INTO bundle_channels (tenant_id, channel, bundle_id, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, channel)
      DO UPDATE SET bundle_id = EXCLUDED.bundle_id, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    `,
    [tenant, channel, bundleID, actor, now]
  );

  await client.query(
    `
      UPDATE bundles
      SET status = 'active',
          rollout_state = CASE WHEN $3 = 'prod' AND rollout_state != 'rolled_back' THEN 'enforced' ELSE rollout_state END
      WHERE tenant_id = $1 AND id = $2
    `,
    [tenant, bundleID, channel]
  );

  await client.query(
    `
      INSERT INTO bundle_activations (
        id, tenant_id, bundle_id, channel, state, activated_by, activated_at, notes
      )
      VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
    `,
    [randomUUID(), tenant, bundleID, channel, actor, now, notes ?? null]
  );

  const promotedResult = await client.query(
    `
      SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
      FROM bundles
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenant, bundleID]
  );
  return promotedResult.rowCount
    ? bundleFromRow(promotedResult.rows[0] as Record<string, unknown>)
    : undefined;
}

export async function promoteBundle(
  bundleID: string,
  channel: BundleChannel,
  input: PromoteBundleInput = {}
): Promise<BundleArtifact | undefined> {
  if (!CHANNELS.has(channel)) {
    throw new Error(`invalid channel: ${channel}`);
  }
  const actor = authoritativeActor(input.actor);

  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();

      const client = await db.connect();
      let promoted: BundleArtifact | undefined;
      try {
        await client.query("BEGIN");
        promoted = await promoteBundleTx(client, tenant, bundleID, channel, actor, input.notes);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      if (promoted) {
        await appendAuditEvent({
          action: "bundle_promoted",
          actor,
          metadata: {
            channel,
            bundleId: promoted.id,
            digest: promoted.digest,
            notes: input.notes ?? ""
          }
        });
      }
      return promoted;
    },
    async () => {
      if (channel !== "prod") {
        return undefined;
      }
      return legacy.activateBundle(bundleID, { ...input, actor });
    }
  );
}

async function rollbackChannelTx(
  client: PoolClient,
  tenant: string,
  channel: BundleChannel,
  actor: string,
  notes?: string
): Promise<BundleArtifact | undefined> {
  const now = new Date().toISOString();
  const currentBundleID = await currentChannelBundleID(client, tenant, channel);
  if (!currentBundleID) {
    return undefined;
  }

  const previousResult = await client.query(
    `
      SELECT bundle_id
      FROM bundle_activations
      WHERE tenant_id = $1 AND channel = $2 AND state = 'active' AND bundle_id != $3
      ORDER BY activated_at DESC
      LIMIT 1
    `,
    [tenant, channel, currentBundleID]
  );
  if (!previousResult.rowCount) {
    return undefined;
  }
  const previousBundleID = String((previousResult.rows[0] as Record<string, unknown>).bundle_id);

  await client.query(
    `
      UPDATE bundle_channels
      SET bundle_id = $1, updated_by = $2, updated_at = $3
      WHERE tenant_id = $4 AND channel = $5
    `,
    [previousBundleID, actor, now, tenant, channel]
  );
  await client.query("UPDATE bundles SET status = 'rolled_back' WHERE tenant_id = $1 AND id = $2", [
    tenant,
    currentBundleID
  ]);
  await client.query("UPDATE bundles SET status = 'active' WHERE tenant_id = $1 AND id = $2", [
    tenant,
    previousBundleID
  ]);
  await client.query(
    `
      INSERT INTO bundle_activations (
        id, tenant_id, bundle_id, channel, state, activated_by, activated_at, notes
      )
      VALUES ($1, $2, $3, $4, 'rolled_back', $5, $6, $7)
    `,
    [randomUUID(), tenant, currentBundleID, channel, actor, now, notes ?? "manual rollback"]
  );
  await client.query(
    `
      INSERT INTO bundle_activations (
        id, tenant_id, bundle_id, channel, state, activated_by, activated_at, notes
      )
      VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
    `,
    [randomUUID(), tenant, previousBundleID, channel, actor, now, notes ?? "rollback restore"]
  );

  const restoredResult = await client.query(
    `
      SELECT id, policy_revision_id, data_revision_id, rollout_state, digest, status, created_by, created_at, snapshot
      FROM bundles
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenant, previousBundleID]
  );
  return restoredResult.rowCount
    ? bundleFromRow(restoredResult.rows[0] as Record<string, unknown>)
    : undefined;
}

export async function rollbackChannel(
  channel: BundleChannel,
  input: PromoteBundleInput = {}
): Promise<BundleArtifact | undefined> {
  if (!CHANNELS.has(channel)) {
    throw new Error(`invalid channel: ${channel}`);
  }
  const actor = authoritativeActor(input.actor);

  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();

      const client = await db.connect();
      let restored: BundleArtifact | undefined;
      try {
        await client.query("BEGIN");
        restored = await rollbackChannelTx(client, tenant, channel, actor, input.notes);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      if (restored) {
        await appendAuditEvent({
          action: "bundle_rolled_back",
          actor,
          metadata: {
            channel,
            restoredBundleId: restored.id,
            notes: input.notes ?? ""
          }
        });
      }

      return restored;
    },
    async () => legacy.rollbackChannel(channel, { ...input, actor })
  );
}

export async function listApprovalRequests(state?: ApprovalState): Promise<ApprovalRequest[]> {
  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const result = state
        ? await db.query(
            `
              SELECT id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
              FROM approval_requests
              WHERE tenant_id = $1 AND state = $2
              ORDER BY created_at DESC
            `,
            [tenant, state]
          )
        : await db.query(
            `
              SELECT id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
              FROM approval_requests
              WHERE tenant_id = $1
              ORDER BY created_at DESC
            `,
            [tenant]
          );
      return result.rows.map((row) => approvalRequestFromRow(row as Record<string, unknown>));
    },
    async () => legacy.listApprovalRequests(state)
  );
}

export async function createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequest> {
  if (!CHANNELS.has(input.channel)) {
    throw new Error(`invalid channel: ${input.channel}`);
  }
  if (input.channel !== "prod") {
    throw new Error("approval workflow is only required for production");
  }
  const actor = authoritativeActor(input.actor);

  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const notes = input.notes?.trim() || undefined;
      const now = new Date().toISOString();
      const client = await db.connect();
      let created: ApprovalRequest | undefined;
      try {
        await client.query("BEGIN");

        let bundleID = input.bundleId?.trim() || "";
        if (input.action === "rollback_channel") {
          const currentBundleID = await currentChannelBundleID(client, tenant, input.channel);
          if (!currentBundleID) {
            throw new Error(`no active bundle found for ${input.channel}`);
          }
          bundleID = currentBundleID;
        }
        if (!bundleID) {
          throw new Error("bundle id is required");
        }

        const bundleCheck = await client.query(
          "SELECT id FROM bundles WHERE tenant_id = $1 AND id = $2 LIMIT 1",
          [tenant, bundleID]
        );
        if (!bundleCheck.rowCount) {
          throw new Error("bundle not found");
        }

        const existing = await client.query(
          `
            SELECT id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
            FROM approval_requests
            WHERE tenant_id = $1 AND bundle_id = $2 AND action = $3 AND channel = $4 AND state = 'pending'
            LIMIT 1
          `,
          [tenant, bundleID, input.action, input.channel]
        );
        if (existing.rowCount) {
          created = approvalRequestFromRow(existing.rows[0] as Record<string, unknown>);
        } else {
          const id = `ar_${randomUUID()}`;
          const inserted = await client.query(
            `
              INSERT INTO approval_requests (
                id, tenant_id, bundle_id, action, channel, state, requested_by, notes, created_at, updated_at
              )
              VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $8)
              RETURNING id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
            `,
            [id, tenant, bundleID, input.action, input.channel, actor, notes ?? null, now]
          );
          created = approvalRequestFromRow(inserted.rows[0] as Record<string, unknown>);
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      if (!created) {
        throw new Error("failed to create approval request");
      }

      await appendAuditEvent({
        action: "approval_requested",
        actor,
        metadata: {
          approvalRequestId: created.id,
          action: created.action,
          channel: created.channel,
          bundleId: created.bundleId,
          notes: created.notes ?? ""
        }
      });
      return created;
    },
    async () =>
      legacy.createApprovalRequest({
        action: input.action,
        bundleId: input.bundleId,
        channel: input.channel,
        actor,
        notes: input.notes
      })
  );
}

export async function approveApprovalRequest(
  id: string,
  input: ReviewApprovalRequestInput = {}
): Promise<{ approvalRequest: ApprovalRequest; bundle?: BundleArtifact } | undefined> {
  const actor = authoritativeActor(input.actor);
  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const reviewNotes = input.notes?.trim() || undefined;
      const now = new Date().toISOString();
      const client = await db.connect();
      let approved: ApprovalRequest | undefined;
      let promotedBundle: BundleArtifact | undefined;
      let action: ApprovalAction | undefined;
      let channel: BundleChannel | undefined;
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `
            SELECT id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
            FROM approval_requests
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          [tenant, id]
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return undefined;
        }
        const request = approvalRequestFromRow(current.rows[0] as Record<string, unknown>);
        if (request.state !== "pending") {
          throw new Error("approval request is not pending");
        }
        assertIndependentApprovalReviewer(request, actor);

        const actionNotes = reviewNotes ?? request.notes;
        action = request.action;
        channel = request.channel;
        if (request.action === "promote_bundle") {
          promotedBundle = await promoteBundleTx(
            client,
            tenant,
            request.bundleId,
            request.channel,
            actor,
            actionNotes
          );
          if (!promotedBundle) {
            throw new Error("bundle not found");
          }
        } else {
          promotedBundle = await rollbackChannelTx(client, tenant, request.channel, actor, actionNotes);
          if (!promotedBundle) {
            throw new Error(`no previous bundle found for channel ${request.channel}`);
          }
        }

        const updated = await client.query(
          `
            UPDATE approval_requests
            SET state = 'approved',
                reviewed_by = $1,
                reviewed_at = $2,
                review_notes = $3,
                updated_at = $2
            WHERE tenant_id = $4 AND id = $5
            RETURNING id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
          `,
          [actor, now, reviewNotes ?? null, tenant, id]
        );
        approved = approvalRequestFromRow(updated.rows[0] as Record<string, unknown>);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      if (!approved) {
        return undefined;
      }

      if (action === "promote_bundle" && promotedBundle && channel) {
        await appendAuditEvent({
          action: "bundle_promoted",
          actor,
          metadata: {
            channel,
            bundleId: promotedBundle.id,
            digest: promotedBundle.digest,
            notes: reviewNotes ?? approved.notes ?? ""
          }
        });
      } else if (action === "rollback_channel" && promotedBundle && channel) {
        await appendAuditEvent({
          action: "bundle_rolled_back",
          actor,
          metadata: {
            channel,
            restoredBundleId: promotedBundle.id,
            notes: reviewNotes ?? approved.notes ?? ""
          }
        });
      }

      await appendAuditEvent({
        action: "approval_approved",
        actor,
        metadata: {
          approvalRequestId: approved.id,
          action: approved.action,
          channel: approved.channel,
          bundleId: approved.bundleId,
          notes: reviewNotes ?? ""
        }
      });

      return {
        approvalRequest: approved,
        bundle: promotedBundle
      };
    },
    async () => legacy.approveApprovalRequest(id, { ...input, actor })
  );
}

export async function rejectApprovalRequest(
  id: string,
  input: ReviewApprovalRequestInput = {}
): Promise<ApprovalRequest | undefined> {
  const actor = authoritativeActor(input.actor);
  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const reviewNotes = input.notes?.trim() || undefined;
      const now = new Date().toISOString();
      const result = await db.query(
        `
          UPDATE approval_requests
          SET state = 'rejected',
              reviewed_by = $1,
              reviewed_at = $2,
              review_notes = $3,
              updated_at = $2
          WHERE tenant_id = $4 AND id = $5 AND state = 'pending'
          RETURNING id, bundle_id, action, channel, state, requested_by, reviewed_by, notes, review_notes, created_at, updated_at, reviewed_at
        `,
        [actor, now, reviewNotes ?? null, tenant, id]
      );
      if (!result.rowCount) {
        return undefined;
      }
      const rejected = approvalRequestFromRow(result.rows[0] as Record<string, unknown>);
      await appendAuditEvent({
        action: "approval_rejected",
        actor,
        metadata: {
          approvalRequestId: rejected.id,
          action: rejected.action,
          channel: rejected.channel,
          bundleId: rejected.bundleId,
          notes: reviewNotes ?? ""
        }
      });
      return rejected;
    },
    async () => legacy.rejectApprovalRequest(id, { ...input, actor })
  );
}

export async function getChannelManifest(channel: BundleChannel): Promise<BundleManifest | null> {
  if (!CHANNELS.has(channel)) {
    throw new Error(`invalid channel: ${channel}`);
  }
  const signing = await resolveBundleSigningConfig();

  return withDbOrFallback(
    async (db) => {
      let result = await db.query(
        `
          SELECT b.id, b.digest, b.policy_revision_id, b.data_revision_id, b.rollout_state
          FROM bundle_channels c
          JOIN bundles b ON b.id = c.bundle_id
          WHERE c.tenant_id = $1 AND c.channel = $2
          LIMIT 1
        `,
        [defaultTenantId(), channel]
      );
      if (!result.rowCount && channel === "prod") {
        const bootstrapped = await publishBundle({
          rolloutState: "enforced",
          actor: defaultActor()
        });
        await promoteBundle(bootstrapped.id, "prod", {
          actor: defaultActor(),
          notes: "auto bootstrap prod channel"
        });
        result = await db.query(
          `
            SELECT b.id, b.digest, b.policy_revision_id, b.data_revision_id, b.rollout_state
            FROM bundle_channels c
            JOIN bundles b ON b.id = c.bundle_id
            WHERE c.tenant_id = $1 AND c.channel = $2
            LIMIT 1
          `,
          [defaultTenantId(), channel]
        );
      }
      if (!result.rowCount) {
        return null;
      }
      const row = result.rows[0] as Record<string, unknown>;
      const rolloutState = String(row.rollout_state) as RolloutState;
      return {
        channel,
        bundleId: String(row.id),
        digest: String(row.digest),
        policyRevisionId: String(row.policy_revision_id),
        dataRevisionId: String(row.data_revision_id),
        rolloutState,
        enforcementMode: rolloutState === "shadow" ? "shadow" : "enforce",
        artifactPath: `/api/bundles/artifacts/${encodeURIComponent(String(row.id))}`,
        signingKeyID: signing.keyID,
        signingScope: signing.scope,
        signingAlgorithm: signing.algorithm,
        generatedAt: new Date().toISOString()
      };
    },
    async () => {
      if (channel !== "prod") {
        return null;
      }
      const bundle = await legacy.getActiveBundle();
      if (!bundle) {
        const bootstrapped = await legacy.publishBundle({
          rolloutState: "enforced",
          actor: defaultActor()
        });
        const promoted = await legacy.activateBundle(bootstrapped.id, {
          actor: defaultActor(),
          notes: "auto bootstrap prod channel"
        });
        if (!promoted) {
          return null;
        }
        return {
          channel: "prod",
          bundleId: promoted.id,
          digest: promoted.digest,
          policyRevisionId: promoted.policyRevisionId,
          dataRevisionId: promoted.dataRevisionId,
          rolloutState: promoted.rolloutState,
          enforcementMode: promoted.rolloutState === "shadow" ? "shadow" : "enforce",
          artifactPath: `/api/bundles/artifacts/${encodeURIComponent(promoted.id)}`,
          signingKeyID: signing.keyID,
          signingScope: signing.scope,
          signingAlgorithm: signing.algorithm,
          generatedAt: new Date().toISOString()
        };
      }
      return {
        channel: "prod",
        bundleId: bundle.id,
        digest: bundle.digest,
        policyRevisionId: bundle.policyRevisionId,
        dataRevisionId: bundle.dataRevisionId,
        rolloutState: bundle.rolloutState,
        enforcementMode: bundle.rolloutState === "shadow" ? "shadow" : "enforce",
        artifactPath: `/api/bundles/artifacts/${encodeURIComponent(bundle.id)}`,
        signingKeyID: signing.keyID,
        signingScope: signing.scope,
        signingAlgorithm: signing.algorithm,
        generatedAt: new Date().toISOString()
      };
    }
  );
}

export async function getChannelArchive(
  channel: BundleChannel
): Promise<{ content: Buffer; fileName: string; digest: string } | null> {
  const manifest = await getChannelManifest(channel);
  if (!manifest) {
    return null;
  }
  return getBundleArchive(manifest.bundleId);
}

async function addTarEntry(pack: tar.Pack, name: string, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name, mode: 0o644 }, payload, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function listFilesRecursively(root: string): Promise<string[]> {
  let files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await listFilesRecursively(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

type BundleArchiveEntry = {
  name: string;
  payload: Buffer;
};

type BundleSignatureFile = {
  name: string;
  hash: string;
  algorithm: "SHA-256";
};

function canonicalizeStructuredJSON(raw: Buffer): Buffer {
  const value = JSON.parse(raw.toString("utf8")) as unknown;
  return Buffer.from(stableStringify(value), "utf8");
}

function hashBundleFile(name: string, payload: Buffer): string {
  if (name === ".manifest" || name === "data.json") {
    return createHash("sha256").update(canonicalizeStructuredJSON(payload)).digest("hex");
  }
  return createHash("sha256").update(payload).digest("hex");
}

function toBase64URL(payload: Buffer | string): string {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return raw.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64URL(payload: string): Buffer {
  let normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return Buffer.from(normalized, "base64");
}

async function signWithExternalBundleSigner(signingInput: string, signing: BundleSigningConfig): Promise<string> {
  const signer = signing.externalSigner;
  if (!signer) {
    throw new Error("external bundle signer is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), signer.timeoutMs);
  try {
    const response = await fetch(signer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signer.token ? { Authorization: `Bearer ${signer.token}` } : {})
      },
      body: JSON.stringify({
        version: "v1",
        algorithm: signing.algorithm,
        key_id: signing.keyID,
        scope: signing.scope,
        signing_input: signingInput
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`external bundle signer returned ${response.status}`);
    }
    const payload = (await response.json()) as { signature?: unknown };
    const signature = typeof payload.signature === "string" ? payload.signature : "";
    if (!/^[A-Za-z0-9_-]+$/.test(signature) || fromBase64URL(signature).length < 256) {
      throw new Error("external bundle signer returned an invalid RS256 signature");
    }
    return signature;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("external bundle signer")) {
      throw error;
    }
    throw new Error("external bundle signer request failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function signBundleFiles(files: BundleSignatureFile[], signing: BundleSigningConfig, issuedAtUnix: number): Promise<string> {
  const header = {
    alg: signing.algorithm,
    typ: "JWT",
    kid: signing.keyID
  };
  const payload = {
    files,
    scope: signing.scope,
    keyid: signing.keyID,
    iat: issuedAtUnix,
    iss: "arbiter-control-plane"
  };
  const signingInput = `${toBase64URL(JSON.stringify(header))}.${toBase64URL(JSON.stringify(payload))}`;
  if (signing.externalSigner) {
    return `${signingInput}.${await signWithExternalBundleSigner(signingInput, signing)}`;
  }
  if (!signing.secret) {
    throw new Error("bundle signing secret is required");
  }
  const signature =
    signing.algorithm === "HS256"
      ? createHmac("sha256", signing.secret).update(signingInput).digest()
      : signDetached("RSA-SHA256", Buffer.from(signingInput, "utf8"), signing.secret);
  return `${signingInput}.${toBase64URL(signature)}`;
}

async function buildBundleArchive(bundle: BundleArtifact): Promise<Buffer> {
  const pack = tar.pack();
  const tarBufferPromise = streamToBuffer(pack);
  const createdAt = bundle.createdAt;
  const issuedAtUnix = Math.floor(new Date(createdAt).getTime() / 1000);
  const signing = await resolveBundleSigningConfig();
  const entries: BundleArchiveEntry[] = [];
  const queueEntry = (name: string, payload: Buffer): void => {
    entries.push({ name, payload });
  };

  const enforcementMode = bundle.rolloutState === "shadow" ? "shadow" : "enforce";
  const runtimeRevision = createHash("sha256")
    .update(`${bundle.digest}:${bundle.rolloutState}`)
    .digest("hex");
  const manifest = {
    revision: runtimeRevision,
    roots: [""],
    metadata: {
      bundle_id: bundle.id,
      policy_revision_id: bundle.policyRevisionId,
      data_revision_id: bundle.dataRevisionId,
      rollout_state: bundle.rolloutState,
      enforcement_mode: enforcementMode,
      created_at: createdAt,
      signing_key_id: signing.keyID,
      signing_scope: signing.scope
    }
  };
  queueEntry(".manifest", Buffer.from(JSON.stringify(manifest, null, 2)));

  const root = policyRoot();
  const coreRoot = path.join(root, "core");
  const domainRoot = path.join(root, "domain");

  for (const rootDir of [coreRoot, domainRoot]) {
    let files: string[];
    try {
      files = (await listFilesRecursively(rootDir))
        .filter((file) => file.endsWith(".rego"))
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      throw missingPolicyTreeError(root, err);
    }
    for (const file of files) {
      const payload = await readFile(file);
      const name = path.relative(root, file).replaceAll(path.sep, "/");
      queueEntry(name, payload);
    }
  }

  const arbiterDataPath = path.join(root, "arbiter.json");
  let arbiterData: Record<string, unknown> = {};
  try {
    arbiterData = JSON.parse(await readFile(arbiterDataPath, "utf8")) as Record<string, unknown>;
  } catch {
    arbiterData = {};
  }
  const config = asObject(arbiterData.config);
  arbiterData.config = {
    ...config,
    policy_version: bundle.policyRevisionId,
    data_revision: bundle.dataRevisionId,
    rollout_state: bundle.rolloutState,
    enforcement_mode: enforcementMode
  };
  arbiterData.control_plane_bundle = {
    bundle_id: bundle.id,
    digest: bundle.digest,
    rollout_state: bundle.rolloutState,
    enforcement_mode: enforcementMode,
    snapshot: bundle.snapshot,
    signing: {
      algorithm: signing.algorithm,
      key_id: signing.keyID,
      scope: signing.scope
    }
  };
  queueEntry("data.json", Buffer.from(JSON.stringify({ arbiter: arbiterData }, null, 2)));
  queueEntry("snapshot.json", Buffer.from(JSON.stringify(bundle.snapshot, null, 2)));

  const signatureFiles: BundleSignatureFile[] = entries.map(({ name, payload }) => ({
    name,
    hash: hashBundleFile(name, payload),
    algorithm: "SHA-256"
  }));
  queueEntry(
    ".signatures.json",
    Buffer.from(
      JSON.stringify(
        {
          signatures: [await signBundleFiles(signatureFiles, signing, issuedAtUnix)]
        },
        null,
        2
      )
    )
  );

  for (const entry of entries) {
    await addTarEntry(pack, entry.name, entry.payload);
  }

  pack.finalize();
  const tarBuffer = await tarBufferPromise;
  return gzip(tarBuffer);
}

export async function getBundleArchive(
  bundleID: string
): Promise<{ content: Buffer; fileName: string; digest: string } | null> {
  const bundle = await getBundle(bundleID);
  if (!bundle) {
    return null;
  }
  const content = await buildBundleArchive(bundle);
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    content,
    fileName: `${bundle.id}.tar.gz`,
    digest
  };
}

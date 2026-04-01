import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { Pool } from "pg";
import tar from "tar-stream";

import { defaultActor, defaultTenantId } from "./context";
import { dbEnabled, ensureMigrations, getPool } from "./db";
import * as legacy from "./store_legacy";
import type {
  AuditEvent,
  BundleActivation,
  BundleArtifact,
  DataRevision,
  PolicyRecord,
  PolicyRevision,
  RolloutState,
  SigningKey,
  ServiceToken
} from "./types";

const gzip = promisify(gzipCallback);
const CHANNELS = new Set(["dev", "staging", "prod"]);

type BundleChannel = "dev" | "staging" | "prod";

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
  return {
    id: String(row.id),
    name: String(row.name),
    keyId: String(row.key_id),
    scope: String(row.scope),
    algorithm: "HS256",
    isActive: Boolean(row.is_active),
    createdBy: String(row.created_by),
    createdAt: toISOString(row.created_at),
    activatedAt: row.activated_at ? toISOString(row.activated_at) : undefined,
    revokedAt: row.revoked_at ? toISOString(row.revoked_at) : undefined
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

type BundleManifest = {
  channel: BundleChannel;
  bundleId: string;
  digest: string;
  policyRevisionId: string;
  dataRevisionId: string;
  artifactPath: string;
  signingKeyID: string;
  signingScope: string;
  signingAlgorithm: "HS256";
  generatedAt: string;
};

type ValidatedServiceToken = {
  id: string;
  name: string;
  scopes: string[];
};

type BundleSigningConfig = {
  keyID: string;
  scope: string;
  secret: string;
  algorithm: "HS256";
};

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
  const keyID = (process.env.ARBITER_BUNDLE_SIGNING_KEY_ID ?? "arbiter_bundle_hs256").trim();
  const scope = (process.env.ARBITER_BUNDLE_SIGNING_SCOPE ?? "read").trim();
  const secret = (process.env.ARBITER_BUNDLE_SIGNING_SECRET ?? "dev-bundle-signing-secret").trim();
  if (!secret) {
    throw new Error("bundle signing secret is required");
  }
  return {
    keyID: keyID || "arbiter_bundle_hs256",
    scope: scope || "read",
    secret,
    algorithm: "HS256"
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
  const now = new Date().toISOString();
  await db.query(
    `
      INSERT INTO signing_keys (
        id, tenant_id, name, key_id, scope, algorithm, secret, is_active, created_by, created_at, activated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $10)
      ON CONFLICT (tenant_id, key_id) DO UPDATE
      SET
        name = EXCLUDED.name,
        scope = EXCLUDED.scope,
        algorithm = EXCLUDED.algorithm,
        secret = EXCLUDED.secret,
        is_active = TRUE,
        revoked_at = NULL,
        activated_at = COALESCE(signing_keys.activated_at, EXCLUDED.activated_at)
    `,
    [
      "sk_bootstrap",
      defaultTenantId(),
      "bootstrap-bundle-signing-key",
      bootstrap.keyID,
      bootstrap.scope,
      bootstrap.algorithm,
      bootstrap.secret,
      defaultActor(),
      now,
      now
    ]
  );
  await db.query(
    `
      UPDATE signing_keys
      SET is_active = FALSE
      WHERE tenant_id = $1 AND id <> (
        SELECT id
        FROM signing_keys
        WHERE tenant_id = $1 AND key_id = $2
        LIMIT 1
      ) AND is_active = TRUE
    `,
    [defaultTenantId(), bootstrap.keyID]
  );
}

async function resolveBundleSigningConfig(): Promise<BundleSigningConfig> {
  const fallback = bundleSigningConfig();
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
    return fallback;
  }
  const row = result.rows[0] as Record<string, unknown>;
  return {
    keyID: String(row.key_id),
    scope: String(row.scope),
    secret: String(row.secret),
    algorithm: "HS256"
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
          SELECT id, name, scopes
          FROM service_tokens
          WHERE tenant_id = $1 AND token_hash = $2 AND revoked_at IS NULL
          LIMIT 1
        `,
        [defaultTenantId(), tokenHash(candidate)]
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
          input.actor?.trim() || defaultActor(),
          now
        ]
      );
      const record: ServiceToken = {
        id,
        name,
        scopes: normalizedScopes,
        createdBy: input.actor?.trim() || defaultActor(),
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

type CreateSigningKeyInput = {
  name: string;
  secret: string;
  keyId?: string;
  scope?: string;
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
  const activate = Boolean(input.activate);
  const actor = input.actor?.trim() || defaultActor();

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
            VALUES ($1, $2, $3, $4, $5, 'HS256', $6, $7, $8, $9, $10)
            RETURNING id, name, key_id, scope, algorithm, is_active, created_by, created_at, activated_at, revoked_at
          `,
          [id, defaultTenantId(), name, keyId, scope, secret, activate, actor, now, activate ? now : null]
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
  const actor = input.actor?.trim() || defaultActor();
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
  const actor = input.actor?.trim() || defaultActor();
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
          SELECT id, action, actor, policy_id, at, metadata
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
          metadata: asObject(record.metadata)
        };
      });
    },
    async () => legacy.listAuditEvents()
  );
}

export async function appendAuditEvent(event: Omit<AuditEvent, "id" | "at">): Promise<AuditEvent> {
  return withDbOrFallback(
    async (db) => {
      const created: AuditEvent = {
        ...event,
        id: randomUUID(),
        at: new Date().toISOString()
      };
      await db.query(
        `
          INSERT INTO audit_events (id, tenant_id, action, actor, policy_id, at, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          created.id,
          defaultTenantId(),
          created.action,
          created.actor,
          created.policyId ?? null,
          created.at,
          JSON.stringify(created.metadata ?? {})
        ]
      );
      return created;
    },
    async () => legacy.appendAuditEvent(event)
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
  return withDbOrFallback(
    async (db) => {
      const now = new Date().toISOString();
      const actor = input.actor?.trim() || defaultActor();
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
    async () => legacy.publishBundle(input)
  );
}

export async function activateBundle(id: string, input: ActivateBundleInput = {}): Promise<BundleArtifact | undefined> {
  return promoteBundle(id, "prod", input);
}

export async function promoteBundle(
  bundleID: string,
  channel: BundleChannel,
  input: PromoteBundleInput = {}
): Promise<BundleArtifact | undefined> {
  if (!CHANNELS.has(channel)) {
    throw new Error(`invalid channel: ${channel}`);
  }

  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const actor = input.actor?.trim() || defaultActor();
      const now = new Date().toISOString();

      const client = await db.connect();
      let promoted: BundleArtifact | undefined;
      try {
        await client.query("BEGIN");

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
          await client.query("ROLLBACK");
          return undefined;
        }

        const currentResult = await client.query(
          `
            SELECT bundle_id
            FROM bundle_channels
            WHERE tenant_id = $1 AND channel = $2
            LIMIT 1
          `,
          [tenant, channel]
        );

        if (currentResult.rowCount) {
          const currentBundleID = String((currentResult.rows[0] as Record<string, unknown>).bundle_id);
          if (currentBundleID !== bundleID) {
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
          [randomUUID(), tenant, bundleID, channel, actor, now, input.notes ?? null]
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
        promoted = promotedResult.rowCount
          ? bundleFromRow(promotedResult.rows[0] as Record<string, unknown>)
          : undefined;

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
      return legacy.activateBundle(bundleID, input);
    }
  );
}

export async function rollbackChannel(
  channel: BundleChannel,
  input: PromoteBundleInput = {}
): Promise<BundleArtifact | undefined> {
  if (!CHANNELS.has(channel)) {
    throw new Error(`invalid channel: ${channel}`);
  }

  return withDbOrFallback(
    async (db) => {
      const tenant = defaultTenantId();
      const actor = input.actor?.trim() || defaultActor();
      const now = new Date().toISOString();

      const client = await db.connect();
      let restored: BundleArtifact | undefined;
      try {
        await client.query("BEGIN");

        const currentResult = await client.query(
          `
            SELECT bundle_id
            FROM bundle_channels
            WHERE tenant_id = $1 AND channel = $2
            LIMIT 1
          `,
          [tenant, channel]
        );
        if (!currentResult.rowCount) {
          await client.query("ROLLBACK");
          return undefined;
        }
        const currentBundleID = String((currentResult.rows[0] as Record<string, unknown>).bundle_id);

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
          await client.query("ROLLBACK");
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
        await client.query(
          "UPDATE bundles SET status = 'rolled_back' WHERE tenant_id = $1 AND id = $2",
          [tenant, currentBundleID]
        );
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
          [randomUUID(), tenant, currentBundleID, channel, actor, now, input.notes ?? "manual rollback"]
        );
        await client.query(
          `
            INSERT INTO bundle_activations (
              id, tenant_id, bundle_id, channel, state, activated_by, activated_at, notes
            )
            VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
          `,
          [randomUUID(), tenant, previousBundleID, channel, actor, now, input.notes ?? "rollback restore"]
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
        restored = restoredResult.rowCount
          ? bundleFromRow(restoredResult.rows[0] as Record<string, unknown>)
          : undefined;

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
    async () => undefined
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
          SELECT b.id, b.digest, b.policy_revision_id, b.data_revision_id
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
            SELECT b.id, b.digest, b.policy_revision_id, b.data_revision_id
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
      return {
        channel,
        bundleId: String(row.id),
        digest: String(row.digest),
        policyRevisionId: String(row.policy_revision_id),
        dataRevisionId: String(row.data_revision_id),
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

function isStructuredBundleFile(fileName: string): boolean {
  return fileName === ".manifest" || fileName.endsWith(".json") || fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

function canonicalizeStructuredJSON(raw: Buffer): Buffer {
  const value = JSON.parse(raw.toString("utf8")) as unknown;
  return Buffer.from(stableStringify(value), "utf8");
}

function hashBundleFile(name: string, payload: Buffer): string {
  if (isStructuredBundleFile(name)) {
    try {
      return createHash("sha256").update(canonicalizeStructuredJSON(payload)).digest("hex");
    } catch {
      // Fall back to raw bytes if the file cannot be parsed as structured JSON.
    }
  }
  return createHash("sha256").update(payload).digest("hex");
}

function toBase64URL(payload: Buffer | string): string {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return raw.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function signBundleFiles(files: BundleSignatureFile[], signing: BundleSigningConfig, issuedAtUnix: number): string {
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
  const signature = createHmac("sha256", signing.secret).update(signingInput).digest();
  return `${signingInput}.${toBase64URL(signature)}`;
}

async function buildBundleArchive(bundle: BundleArtifact): Promise<Buffer> {
  const pack = tar.pack();
  const createdAt = bundle.createdAt;
  const issuedAtUnix = Math.floor(new Date(createdAt).getTime() / 1000);
  const signing = await resolveBundleSigningConfig();
  const entries: BundleArchiveEntry[] = [];
  const queueEntry = (name: string, payload: Buffer): void => {
    entries.push({ name, payload });
  };

  const manifest = {
    revision: bundle.digest,
    roots: [""],
    metadata: {
      bundle_id: bundle.id,
      policy_revision_id: bundle.policyRevisionId,
      data_revision_id: bundle.dataRevisionId,
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
    data_revision: bundle.dataRevisionId
  };
  arbiterData.control_plane_bundle = {
    bundle_id: bundle.id,
    digest: bundle.digest,
    snapshot: bundle.snapshot,
    signing: {
      algorithm: signing.algorithm,
      key_id: signing.keyID,
      scope: signing.scope
    }
  };
  queueEntry("arbiter.json", Buffer.from(JSON.stringify(arbiterData, null, 2)));
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
          signatures: [signBundleFiles(signatureFiles, signing, issuedAtUnix)]
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
  const tarBuffer = await streamToBuffer(pack);
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
  return {
    content,
    fileName: `${bundle.id}.tar.gz`,
    digest: bundle.digest
  };
}

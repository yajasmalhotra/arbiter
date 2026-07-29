import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const MOCK_BUNDLE = {
  id: "bundle_test_prod",
  policyRevisionId: "pr_test_bundle",
  dataRevisionId: "dr_test_bundle",
  rolloutState: "enforced",
  digest: "digest_test_bundle",
  status: "active",
  createdBy: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  snapshot: {
    policies: [],
    data: {}
  }
} as const;

vi.mock("./store_legacy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store_legacy")>();
  return {
    ...actual,
    getBundle: vi.fn(async () => MOCK_BUNDLE),
    getActiveBundle: vi.fn(async () => MOCK_BUNDLE),
    publishBundle: vi.fn(async () => MOCK_BUNDLE),
    activateBundle: vi.fn(async () => MOCK_BUNDLE),
    rollbackChannel: vi.fn(async () => MOCK_BUNDLE)
  };
});

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function decodeBase64URL(value: string): Buffer {
  let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return Buffer.from(normalized, "base64");
}

function decodeJWTPayload<T>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid JWT shape");
  }
  return JSON.parse(decodeBase64URL(parts[1]).toString("utf8")) as T;
}

function decodeJWTHeader<T>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid JWT shape");
  }
  return JSON.parse(decodeBase64URL(parts[0]).toString("utf8")) as T;
}

async function unpackTarGz(archive: Buffer): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const extract = tar.extract();

  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => {
        files.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    extract.end(gunzipSync(archive));
  });

  return files;
}

type SignaturePayload = {
  files: Array<{
    name: string;
    hash: string;
    algorithm: "SHA-256";
  }>;
};

describe("bundle archive regression coverage", () => {
  const envBackup: Record<string, string | undefined> = {};
  let files: Map<string, Buffer>;
  let archiveContent: Buffer;
  let archiveDigest: string;

  beforeAll(async () => {
    const trackedEnv = [
      "ARBITER_DB_URL",
      "ARBITER_POLICY_ROOT",
      "ARBITER_BUNDLE_SIGNING_SECRET",
      "ARBITER_BUNDLE_SIGNING_KEY_ID",
      "ARBITER_BUNDLE_SIGNING_SCOPE",
      "ARBITER_BUNDLE_SIGNING_ALGORITHM",
      "ARBITER_BUNDLE_SIGNER_URL",
      "ARBITER_BUNDLE_SIGNER_TOKEN",
      "ARBITER_BUNDLE_SIGNER_TIMEOUT_MS",
      "ARBITER_CAPABILITY_ALGORITHM",
      "ARBITER_CAPABILITY_PRIVATE_KEY",
      "ARBITER_CAPABILITY_SECRET",
      "ARBITER_CAPABILITY_KID"
    ] as const;

    for (const key of trackedEnv) {
      envBackup[key] = process.env[key];
    }

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(thisDir, "..", "..", "..");

    delete process.env.ARBITER_DB_URL;
    process.env.ARBITER_POLICY_ROOT = path.join(repoRoot, "policy");
    process.env.ARBITER_BUNDLE_SIGNING_SECRET = "bundle-test-secret";
    process.env.ARBITER_BUNDLE_SIGNING_KEY_ID = "bundle_test_hs256";
    process.env.ARBITER_BUNDLE_SIGNING_SCOPE = "read";
    process.env.ARBITER_BUNDLE_SIGNING_ALGORITHM = "HS256";

    const { getChannelArchive } = await import("./store");
    const archive = await getChannelArchive("prod");
    if (!archive) {
      throw new Error("expected prod archive");
    }

    archiveContent = archive.content;
    archiveDigest = archive.digest;
    files = await unpackTarGz(archive.content);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses content-addressed archive digests and expected payload files", () => {
    expect(archiveDigest).toBe(sha256Hex(archiveContent));
    expect(files.has(".manifest")).toBe(true);
    expect(files.has(".signatures.json")).toBe(true);
    expect(files.has("data.json")).toBe(true);
    expect(files.has("snapshot.json")).toBe(true);
    expect(files.has("arbiter.json")).toBe(false);

    const data = JSON.parse((files.get("data.json") as Buffer).toString("utf8")) as {
      arbiter: {
        config: { policy_version: string; data_revision: string };
        tools: Record<string, { domain: string }>;
      };
    };

    expect(data.arbiter.config.policy_version).toMatch(/^pr_/);
    expect(data.arbiter.config.data_revision).toMatch(/^dr_/);
    expect(data.arbiter.tools.send_slack_message.domain).toBe("slack");
    expect(data.arbiter.tools.run_sql_query.domain).toBe("sql");
  });

  it("hashes .manifest and data.json canonically while keeping snapshot.json raw", () => {
    const signatureDoc = JSON.parse((files.get(".signatures.json") as Buffer).toString("utf8")) as {
      signatures: string[];
    };
    expect(signatureDoc.signatures.length).toBeGreaterThan(0);

    const payload = decodeJWTPayload<SignaturePayload>(signatureDoc.signatures[0]);
    const hashes = new Map(payload.files.map((entry) => [entry.name, entry.hash]));

    const manifestRaw = files.get(".manifest") as Buffer;
    const manifestCanonical = Buffer.from(stableStringify(JSON.parse(manifestRaw.toString("utf8"))), "utf8");
    expect(hashes.get(".manifest")).toBe(sha256Hex(manifestCanonical));
    expect(hashes.get(".manifest")).not.toBe(sha256Hex(manifestRaw));

    const dataRaw = files.get("data.json") as Buffer;
    const dataCanonical = Buffer.from(stableStringify(JSON.parse(dataRaw.toString("utf8"))), "utf8");
    expect(hashes.get("data.json")).toBe(sha256Hex(dataCanonical));
    expect(hashes.get("data.json")).not.toBe(sha256Hex(dataRaw));

    const snapshotRaw = files.get("snapshot.json") as Buffer;
    expect(hashes.get("snapshot.json")).toBe(sha256Hex(snapshotRaw));
  });

  it("signs bundles with RS256 without distributing the private key to verifiers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ARBITER_BUNDLE_SIGNING_ALGORITHM = "RS256";
    process.env.ARBITER_BUNDLE_SIGNING_KEY_ID = "bundle_test_rs256";
    process.env.ARBITER_BUNDLE_SIGNING_SECRET = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const { getChannelArchive } = await import("./store");
    const archive = await getChannelArchive("prod");
    if (!archive) {
      throw new Error("expected prod archive");
    }
    const rsFiles = await unpackTarGz(archive.content);
    const signatureDoc = JSON.parse((rsFiles.get(".signatures.json") as Buffer).toString("utf8")) as {
      signatures: string[];
    };
    const signature = signatureDoc.signatures[0];
    const [header, payload, encodedSignature] = signature.split(".");

    expect(decodeJWTHeader<{ alg: string; kid: string }>(signature)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "bundle_test_rs256"
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`, "utf8"),
        publicKey,
        decodeBase64URL(encodedSignature)
      )
    ).toBe(true);
  });

  it("signs RS256 capability grants for gateways that hold only the public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ARBITER_CAPABILITY_ALGORITHM = "RS256";
    process.env.ARBITER_CAPABILITY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.ARBITER_CAPABILITY_KID = "capability_test_rs256";
    delete process.env.ARBITER_CAPABILITY_SECRET;

    const { signCapabilityGrant } = await import("./store");
    const token = signCapabilityGrant({
      id: "capability_test_grant",
      name: "RS256 test grant",
      subject: "agent-1",
      serverIds: ["payments"],
      toolNames: ["refund"],
      mayDelegate: false,
      createdBy: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    const [header, payload, encodedSignature] = token.split(".");

    expect(decodeJWTHeader<{ alg: string; kid: string }>(token)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "capability_test_rs256"
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`, "utf8"),
        publicKey,
        decodeBase64URL(encodedSignature)
      )
    ).toBe(true);
  });

  it("uses an external RS256 signer without loading private-key material", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const originalFetch = globalThis.fetch;
    process.env.ARBITER_BUNDLE_SIGNING_ALGORITHM = "RS256";
    process.env.ARBITER_BUNDLE_SIGNING_KEY_ID = "kms-backed-bundle-key";
    process.env.ARBITER_BUNDLE_SIGNER_URL = "https://signer.example.test/v1/sign";
    process.env.ARBITER_BUNDLE_SIGNER_TOKEN = "test-signer-token";
    process.env.ARBITER_BUNDLE_SIGNER_TIMEOUT_MS = "500";
    delete process.env.ARBITER_BUNDLE_SIGNING_SECRET;

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        version: string;
        algorithm: string;
        key_id: string;
        signing_input: string;
      };
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-signer-token" });
      expect(request).toMatchObject({ version: "v1", algorithm: "RS256", key_id: "kms-backed-bundle-key" });
      return new Response(
        JSON.stringify({ signature: sign("RSA-SHA256", Buffer.from(request.signing_input, "utf8"), privateKey).toString("base64url") }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const { getChannelArchive } = await import("./store");
      const archive = await getChannelArchive("prod");
      if (!archive) {
        throw new Error("expected prod archive");
      }
      const externalFiles = await unpackTarGz(archive.content);
      const signatureDoc = JSON.parse((externalFiles.get(".signatures.json") as Buffer).toString("utf8")) as {
        signatures: string[];
      };
      const signature = signatureDoc.signatures[0];
      const [header, payload, encodedSignature] = signature.split(".");
      expect(decodeJWTHeader<{ alg: string; kid: string }>(signature)).toEqual({
        alg: "RS256",
        typ: "JWT",
        kid: "kms-backed-bundle-key"
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`, "utf8"),
          publicKey,
          decodeBase64URL(encodedSignature)
        )
      ).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getChannelArchive } from "./store";

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
      "ARBITER_BUNDLE_SIGNING_SCOPE"
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
});

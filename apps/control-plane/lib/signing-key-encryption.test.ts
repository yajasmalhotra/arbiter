import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSigningKeySecret, encryptSigningKeySecret } from "./store";

describe("signing-key envelope encryption", () => {
  it("encrypts a signing secret and binds it to its tenant and key ID", () => {
    const encryptionKey = randomBytes(32);
    const secret = "-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----";
    const encrypted = encryptSigningKeySecret(secret, encryptionKey, "tenant-a", "bundle-signing-2026");

    expect(encrypted).not.toContain(secret);
    expect(encrypted).toMatch(/^arbiter-signing-key:v1:/);
    expect(decryptSigningKeySecret(encrypted, encryptionKey, "tenant-a", "bundle-signing-2026")).toBe(secret);
    expect(() => decryptSigningKeySecret(encrypted, encryptionKey, "tenant-b", "bundle-signing-2026")).toThrow(
      "unable to decrypt signing key secret"
    );
  });

  it("rejects a malformed encryption key", () => {
    expect(() => encryptSigningKeySecret("secret", randomBytes(31), "tenant-a", "bundle-signing-2026")).toThrow(
      "signing-key encryption key must be 32 bytes"
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialVault } from "../src/core/vault.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function makeVault() {
  const directory = mkdtempSync(join(tmpdir(), "evalforge-vault-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    keyPath: join(directory, "nested", "master.key"),
  };
}

describe("CredentialVault", () => {
  it("persists a protected 32-byte master key and round-trips plaintext", () => {
    const { keyPath } = makeVault();
    const vault = new CredentialVault(keyPath);
    const ciphertext = vault.encrypt("provider-secret");

    expect(vault.decrypt(ciphertext)).toBe("provider-secret");
    expect(readFileSync(keyPath)).toHaveLength(32);
    if (process.platform !== "win32")
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(ciphertext).not.toContain("provider-secret");
    expect(new CredentialVault(keyPath).decrypt(ciphertext)).toBe(
      "provider-secret",
    );
  });

  it("emits a versioned envelope with iv, tag, and ciphertext", () => {
    const { keyPath } = makeVault();
    const envelope = JSON.parse(new CredentialVault(keyPath).encrypt("secret"));
    expect(envelope).toEqual(
      expect.objectContaining({
        v: 1,
        iv: expect.any(String),
        tag: expect.any(String),
        ciphertext: expect.any(String),
      }),
    );
  });

  it("reports malformed and tampered ciphertext safely", () => {
    const { keyPath } = makeVault();
    const vault = new CredentialVault(keyPath);
    for (const malformed of ["not-json", JSON.stringify({ v: 2 }), "{}"])
      expect(() => vault.decrypt(malformed)).toThrow(
        "Invalid vault ciphertext.",
      );

    const envelope = JSON.parse(vault.encrypt("secret"));
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] ^= 1;
    envelope.ciphertext = bytes.toString("base64");
    expect(() => vault.decrypt(JSON.stringify(envelope))).toThrow(
      "Invalid vault ciphertext.",
    );
  });
});

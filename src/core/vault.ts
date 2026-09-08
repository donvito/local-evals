import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

type CiphertextEnvelope = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid vault ciphertext.");
  }
  return Buffer.from(value, "base64url");
}

function loadMasterKey(path: string): Buffer {
  if (!path || typeof path !== "string")
    throw new Error("A master key path is required.");

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const key = readFileSync(path);
    chmodSync(path, 0o600);
    if (key.length !== KEY_BYTES) throw new Error("invalid key length");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((error as Error).message === "invalid key length")
        throw new Error("Invalid vault master key.");
      throw new Error("Unable to read vault master key.");
    }
  }

  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return key;
}

export class CredentialVault {
  private readonly key: Buffer;

  constructor(masterKeyPath: string) {
    this.key = loadMasterKey(masterKeyPath);
  }

  encrypt(plaintext: string): string {
    if (typeof plaintext !== "string")
      throw new Error("Vault plaintext must be a string.");

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const envelope: CiphertextEnvelope = {
      v: VERSION,
      iv: encode(iv),
      tag: encode(cipher.getAuthTag()),
      ciphertext: encode(ciphertext),
    };
    return JSON.stringify(envelope);
  }

  decrypt(value: string): string {
    try {
      if (typeof value !== "string") throw new Error("malformed");
      const envelope = JSON.parse(value) as Partial<CiphertextEnvelope>;
      if (
        !envelope ||
        envelope.v !== VERSION ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      )
        throw new Error("malformed");

      const iv = decode(envelope.iv);
      const tag = decode(envelope.tag);
      const ciphertext = decode(envelope.ciphertext);
      if (iv.length !== IV_BYTES || tag.length !== 16)
        throw new Error("malformed");

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Invalid vault ciphertext.");
    }
  }
}

export const LocalCredentialVault = CredentialVault;
export function createCredentialVault(masterKeyPath: string): CredentialVault {
  return new CredentialVault(masterKeyPath);
}

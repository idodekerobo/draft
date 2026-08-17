import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";

// Bump only when rotating keys, and only once the new
// INFERENCE_CREDENTIAL_KEK_<VERSION> env var is provisioned everywhere that
// decrypts (loadKek reads it by this exact name).
export const CURRENT_CREDENTIAL_KEY_VERSION = "v1";

// Envelope encryption (pilot stage; Supabase Vault out of scope for now).
// credentials.encrypted_payload (bytea, stored as \x<hex>) layout:
//   iv (12 bytes) || authTag (16 bytes) || ciphertext
// KEK is selected by encryption_key_version (e.g. "v1") and read from env
// var INFERENCE_CREDENTIAL_KEK_<VERSION>, so a key rotation only requires
// minting a new env var + version, not rewriting old rows. The env var
// naming stays INFERENCE_CREDENTIAL_KEK_* across all credential providers,
// not just inference, since it's already provisioned under that name.

export type CredentialErrorReason = "missing" | "revoked" | "expired" | "decrypt_failed";

export class CredentialError extends Error {
  constructor(
    message: string,
    public reason: CredentialErrorReason,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

export function loadKek(keyVersion: string): Buffer {
  const envName = `INFERENCE_CREDENTIAL_KEK_${keyVersion.toUpperCase()}`;
  const encoded = required(process.env, envName);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new CredentialError(
      `${envName} must decode (base64) to exactly 32 bytes for AES-256; got ${key.length} bytes`,
      "decrypt_failed",
    );
  }
  return key;
}

/** Convert a Buffer to the `\x<hex>` string form Postgres accepts for bytea columns. */
function bufferToBytea(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

// encrypted_payload arrives as a Buffer/Uint8Array, a \x-prefixed hex string
// (PostgREST's bytea wire format), or occasionally plain base64 — normalize
// all three.
export function parseBytea(value: unknown): Buffer {
  if (value instanceof Buffer) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return Buffer.from(value.slice(2), "hex");
    }
    if (value.startsWith("0x")) {
      return Buffer.from(value.slice(2), "hex");
    }
    return Buffer.from(value, "base64");
  }
  throw new CredentialError(
    `Unsupported encrypted_payload shape: ${typeof value}`,
    "decrypt_failed",
  );
}

export function encryptCredentialPayload(plaintext: string, keyVersion: string): string {
  const kek = loadKek(keyVersion);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new CredentialError(
      `Unexpected GCM auth tag length: ${authTag.length}`,
      "decrypt_failed",
    );
  }
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return bufferToBytea(packed);
}

export function decryptCredentialPayload(encryptedPayload: unknown, keyVersion: string): string {
  const kek = loadKek(keyVersion);
  const packed = parseBytea(encryptedPayload);
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new CredentialError(
      "encrypted_payload is too short to contain iv + authTag",
      "decrypt_failed",
    );
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (cause) {
    throw new CredentialError(
      "Failed to decrypt credentials.encrypted_payload — wrong key, wrong key version, or tampered ciphertext",
      "decrypt_failed",
    );
  }
}

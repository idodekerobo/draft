import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Envelope encryption (pilot stage; Supabase Vault out of scope for now).
// credentials.encrypted_payload (bytea, stored as \x<hex>) layout:
//   iv (12 bytes) || authTag (16 bytes) || ciphertext
// AES-256-GCM via node:crypto. KEK is selected by encryption_key_version
// (e.g. "v1") and read from env var INFERENCE_CREDENTIAL_KEK_<VERSION>, so a
// key rotation only requires minting a new env var + version, not rewriting
// old rows.

export type InferenceCredentialErrorReason =
  | "missing"
  | "revoked"
  | "expired"
  | "decrypt_failed";

export class InferenceCredentialError extends Error {
  constructor(
    message: string,
    public reason: InferenceCredentialErrorReason,
  ) {
    super(message);
    this.name = "InferenceCredentialError";
  }
}

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

interface CredentialSecretRow {
  id: string;
  workspace_id: string;
  status: string;
  expires_at: string | null;
  encrypted_payload: unknown;
  encryption_key_version: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function loadKek(keyVersion: string): Buffer {
  const envName = `INFERENCE_CREDENTIAL_KEK_${keyVersion.toUpperCase()}`;
  const encoded = required(process.env, envName);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new InferenceCredentialError(
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
function parseBytea(value: unknown): Buffer {
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
  throw new InferenceCredentialError(
    `Unsupported encrypted_payload shape: ${typeof value}`,
    "decrypt_failed",
  );
}

// Shared with backend/scripts/seed-inference-credential.ts so the encrypt
// and decrypt sides can't drift apart.
export function encryptCredentialPayload(
  plaintext: string,
  keyVersion: string,
): string {
  const kek = loadKek(keyVersion);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new InferenceCredentialError(
      `Unexpected GCM auth tag length: ${authTag.length}`,
      "decrypt_failed",
    );
  }
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return bufferToBytea(packed);
}

function decryptCredentialPayload(
  encryptedPayload: unknown,
  keyVersion: string,
): string {
  const kek = loadKek(keyVersion);
  const packed = parseBytea(encryptedPayload);
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new InferenceCredentialError(
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
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (cause) {
    throw new InferenceCredentialError(
      "Failed to decrypt credentials.encrypted_payload — wrong key, wrong key version, or tampered ciphertext",
      "decrypt_failed",
    );
  }
}

// Always reads via the service-role client — credentials has RLS enabled
// with zero policies (db/schemas/credentials.sql), so only the service role
// can select encrypted_payload.
export async function resolveInferenceCredential(
  workspaceId: string,
  client?: SupabaseClient,
): Promise<string> {
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: workspace, error: workspaceError } = await db
    .from("workspaces")
    .select("inference_credential_id")
    .eq("id", workspaceId)
    .single();
  if (workspaceError) throw workspaceError;

  const credentialId = (workspace as { inference_credential_id: string | null })
    .inference_credential_id;
  if (!credentialId) {
    throw new InferenceCredentialError(
      `Workspace ${workspaceId} has no inference_credential_id configured`,
      "missing",
    );
  }

  const { data: credential, error: credentialError } = await db
    .from("credentials")
    .select(
      "id, workspace_id, status, expires_at, encrypted_payload, encryption_key_version",
    )
    .eq("id", credentialId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (credentialError) throw credentialError;

  const row = credential as CredentialSecretRow | null;
  if (!row) {
    throw new InferenceCredentialError(
      `Credential ${credentialId} for workspace ${workspaceId} was not found`,
      "missing",
    );
  }

  if (row.status === "revoked") {
    throw new InferenceCredentialError(
      `Credential ${credentialId} has been revoked`,
      "revoked",
    );
  }

  const isExpiredByTimestamp =
    row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
  if (row.status === "expired" || isExpiredByTimestamp) {
    throw new InferenceCredentialError(
      `Credential ${credentialId} has expired`,
      "expired",
    );
  }

  if (row.status !== "active") {
    throw new InferenceCredentialError(
      `Credential ${credentialId} has unexpected status "${row.status}"`,
      "missing",
    );
  }

  return decryptCredentialPayload(row.encrypted_payload, row.encryption_key_version);
}

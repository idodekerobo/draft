import { createHmac, timingSafeEqual } from "node:crypto";

const BUNDLE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** expiresAt is a Unix timestamp in milliseconds. */
export interface SandboxCallbackClaims {
  runId: string;
  bundleHash: string;
  expiresAt: number;
  nonce: string;
}

export interface VerifySandboxCallbackTokenOptions {
  now?: number;
}

export class SandboxCallbackTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCallbackTokenError";
  }
}

function assertClaims(value: unknown): asserts value is SandboxCallbackClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxCallbackTokenError("Callback token claims are invalid");
  }
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).length !== 4 ||
    typeof claims.runId !== "string" ||
    claims.runId.length === 0 ||
    typeof claims.bundleHash !== "string" ||
    !BUNDLE_HASH_PATTERN.test(claims.bundleHash) ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= 0 ||
    typeof claims.nonce !== "string" ||
    claims.nonce.length === 0
  ) {
    throw new SandboxCallbackTokenError("Callback token claims are invalid");
  }
}

function assertSecret(secret: string): void {
  if (secret.length === 0) {
    throw new SandboxCallbackTokenError("Callback token secret must not be empty");
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sign(encodedPayload: string, secret: string): Uint8Array {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createSandboxCallbackToken(
  claims: SandboxCallbackClaims,
  secret: string,
): string {
  assertSecret(secret);
  assertClaims(claims);
  const payload = JSON.stringify({
    runId: claims.runId,
    bundleHash: claims.bundleHash,
    expiresAt: claims.expiresAt,
    nonce: claims.nonce,
  });
  const encodedPayload = encodeBase64Url(payload);
  return `${encodedPayload}.${encodeBase64Url(sign(encodedPayload, secret))}`;
}

export function verifySandboxCallbackToken(
  token: string,
  secret: string,
  options: VerifySandboxCallbackTokenOptions = {},
): SandboxCallbackClaims {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new SandboxCallbackTokenError("Callback token is malformed");
  }

  let suppliedSignature: Uint8Array;
  try {
    suppliedSignature = Buffer.from(parts[1], "base64url");
  } catch {
    throw new SandboxCallbackTokenError("Callback token is malformed");
  }
  const expectedSignature = sign(parts[0], secret);
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new SandboxCallbackTokenError("Callback token signature is invalid");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new SandboxCallbackTokenError("Callback token claims are invalid");
  }
  assertClaims(claims);
  if ((options.now ?? Date.now()) >= claims.expiresAt) {
    throw new SandboxCallbackTokenError("Callback token has expired");
  }
  return claims;
}

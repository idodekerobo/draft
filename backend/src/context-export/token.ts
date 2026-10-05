import { createHmac, timingSafeEqual } from "node:crypto";

export const CONTEXT_EXPORT_TTL_MS = 5 * 60 * 1000;

/** exp is a Unix timestamp in milliseconds. */
export interface ContextExportClaims {
  workspaceId: string;
  userId: string;
  exp: number;
}

export class ContextExportTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextExportTokenError";
  }
}

function assertClaims(value: unknown): asserts value is ContextExportClaims {
  const claims = value as Record<string, unknown> | null;
  if (
    typeof claims !== "object" ||
    claims === null ||
    Array.isArray(claims) ||
    Object.keys(claims).length !== 3 ||
    typeof claims.workspaceId !== "string" ||
    claims.workspaceId.length === 0 ||
    typeof claims.userId !== "string" ||
    claims.userId.length === 0 ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0
  ) {
    throw new ContextExportTokenError("Export token claims are invalid");
  }
}

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret) throw new ContextExportTokenError("CONTEXT_EXPORT_SECRET is not configured");
}

function sign(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createContextExportToken(claims: ContextExportClaims, secret: string | undefined): string {
  assertSecret(secret);
  assertClaims(claims);
  const encodedPayload = Buffer.from(
    JSON.stringify({ workspaceId: claims.workspaceId, userId: claims.userId, exp: claims.exp }),
  ).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret).toString("base64url")}`;
}

export function verifyContextExportToken(
  token: string,
  secret: string | undefined,
  options: { now?: number } = {},
): ContextExportClaims {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new ContextExportTokenError("Export token is malformed");
  }

  const supplied = Buffer.from(parts[1], "base64url");
  const expected = sign(parts[0], secret);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new ContextExportTokenError("Export token signature is invalid");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new ContextExportTokenError("Export token claims are invalid");
  }
  assertClaims(claims);
  if ((options.now ?? Date.now()) >= claims.exp) {
    throw new ContextExportTokenError("Export token has expired");
  }
  return claims;
}

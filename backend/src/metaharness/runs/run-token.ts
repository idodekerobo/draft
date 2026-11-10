import { createHmac, timingSafeEqual } from "node:crypto";
import { parseAgentRunId, parseWorkspaceId, type AgentRunId, type WorkspaceId } from "draft-core/run-spec";

/** expiresAt is a Unix timestamp in milliseconds. */
export interface AgentRunTokenClaims {
  runId: AgentRunId;
  workspaceId: WorkspaceId;
  expiresAt: number;
  nonce: string;
}

export class AgentRunTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunTokenError";
  }
}

// Derived from the shared secret so a sandbox callback token can never verify here.
function signingKey(secret: string): Buffer {
  if (secret.length === 0) throw new AgentRunTokenError("Agent run token secret must not be empty");
  return createHmac("sha256", secret).update("draft-agent-run-token-v1").digest();
}

function sign(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", signingKey(secret)).update(encodedPayload).digest();
}

export function createAgentRunToken(claims: AgentRunTokenClaims, secret: string): string {
  const payload = JSON.stringify({
    runId: claims.runId,
    workspaceId: claims.workspaceId,
    expiresAt: claims.expiresAt,
    nonce: claims.nonce,
  });
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret).toString("base64url")}`;
}

function parseClaims(value: unknown): AgentRunTokenClaims {
  const invalid = () => new AgentRunTokenError("Agent run token claims are invalid");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).length !== 4 ||
    typeof claims.runId !== "string" ||
    typeof claims.workspaceId !== "string" ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= 0 ||
    typeof claims.nonce !== "string" ||
    claims.nonce.length === 0
  ) {
    throw invalid();
  }
  try {
    return {
      runId: parseAgentRunId(claims.runId),
      workspaceId: parseWorkspaceId(claims.workspaceId),
      expiresAt: claims.expiresAt,
      nonce: claims.nonce,
    };
  } catch {
    throw invalid();
  }
}

export function verifyAgentRunToken(
  token: string,
  secret: string,
  options: { now?: number } = {},
): AgentRunTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new AgentRunTokenError("Agent run token is malformed");
  }
  const supplied = Buffer.from(parts[1], "base64url");
  const expected = sign(parts[0], secret);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new AgentRunTokenError("Agent run token signature is invalid");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new AgentRunTokenError("Agent run token claims are invalid");
  }
  const parsed = parseClaims(claims);
  if ((options.now ?? Date.now()) >= parsed.expiresAt) {
    throw new AgentRunTokenError("Agent run token has expired");
  }
  return parsed;
}

import {
  type SandboxCallbackClaims,
  verifySandboxCallbackToken,
} from "./callback-token";

const BUNDLE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export const DEFAULT_SANDBOX_CALLBACK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface AuthenticateSandboxCallbackRequestOptions {
  /** Unix timestamp in milliseconds, forwarded to callback token verification. */
  now?: number;
  maxBodyBytes?: number;
}

export interface AuthenticatedSandboxCallbackRequest {
  runId: string;
  bundleHash: string;
  result: unknown;
  claims: SandboxCallbackClaims;
}

export class SandboxCallbackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCallbackRequestError";
  }
}

function reject(message: string): never {
  throw new SandboxCallbackRequestError(message);
}

function parseContentLength(value: string | null, maximum: number): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) reject("Callback Content-Length is invalid");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) reject("Callback Content-Length is invalid");
  if (length > maximum) reject("Callback body is too large");
  return length;
}

async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        reject("Callback body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function topLevelKeys(source: string): string[] {
  const keys: string[] = [];
  let index = 0;
  const whitespace = /\s/;
  const skipWhitespace = (): void => {
    while (index < source.length && whitespace.test(source[index])) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    return reject("Callback body is invalid JSON");
  };

  skipWhitespace();
  if (source[index] !== "{") return [];
  index += 1;
  skipWhitespace();
  if (source[index] === "}") return keys;

  while (index < source.length) {
    if (source[index] !== '"') return reject("Callback body is invalid JSON");
    keys.push(scanString());
    skipWhitespace();
    if (source[index] !== ":") return reject("Callback body is invalid JSON");
    index += 1;

    let nestedDepth = 0;
    let inString = false;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{" || character === "[") nestedDepth += 1;
      else if (character === "}" || character === "]") {
        if (character === "}" && nestedDepth === 0) return keys;
        nestedDepth -= 1;
      } else if (character === "," && nestedDepth === 0) {
        index += 1;
        skipWhitespace();
        break;
      }
      index += 1;
    }
  }
  return keys;
}

function parseBody(bytes: Uint8Array): { run_id: string; bundle_hash: string; result: unknown } {
  let source: string;
  let parsed: unknown;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source) as unknown;
  } catch {
    return reject("Callback body is invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("Callback body is invalid");
  }

  const keys = topLevelKeys(source);
  const expected = new Set(["run_id", "bundle_hash", "result"]);
  if (keys.length !== expected.size || new Set(keys).size !== keys.length || keys.some((key) => !expected.has(key))) {
    return reject("Callback body fields are invalid");
  }

  const body = parsed as Record<string, unknown>;
  if (
    typeof body.run_id !== "string" ||
    body.run_id.length === 0 ||
    typeof body.bundle_hash !== "string" ||
    !BUNDLE_HASH_PATTERN.test(body.bundle_hash)
  ) {
    return reject("Callback body identifiers are invalid");
  }
  return body as { run_id: string; bundle_hash: string; result: unknown };
}

/**
 * Authenticates and parses a sandbox callback without performing persistence or
 * constructing an HTTP response.
 */
export async function authenticateSandboxCallbackRequest(
  request: Request,
  callbackSecret: string,
  options: AuthenticateSandboxCallbackRequestOptions = {},
): Promise<AuthenticatedSandboxCallbackRequest> {
  if (request.method !== "POST") reject("Callback method must be POST");

  const contentType = request.headers.get("content-type");
  if (contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    reject("Callback Content-Type must be application/json");
  }

  const maximum = options.maxBodyBytes ?? DEFAULT_SANDBOX_CALLBACK_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    reject("Callback body size limit is invalid");
  }
  const declaredLength = parseContentLength(request.headers.get("content-length"), maximum);

  const authorization = request.headers.get("authorization");
  const authorizationMatch = authorization?.match(/^Bearer ([^\s,]+)$/i);
  if (!authorizationMatch) reject("Callback authorization is invalid");

  let claims: SandboxCallbackClaims;
  try {
    claims = verifySandboxCallbackToken(authorizationMatch[1], callbackSecret, { now: options.now });
  } catch {
    return reject("Callback authentication failed");
  }

  const runId = request.headers.get("x-draft-run-id");
  const bundleHash = request.headers.get("x-draft-bundle-hash");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!runId || !bundleHash || !idempotencyKey) reject("Callback identity headers are missing");

  const bodyBytes = await readBoundedBody(request, maximum);
  if (declaredLength !== undefined && declaredLength !== bodyBytes.byteLength) {
    reject("Callback Content-Length does not match body");
  }
  const body = parseBody(bodyBytes);

  const expectedIdempotencyKey = `draft:${claims.runId}:${claims.bundleHash}`;
  if (
    runId !== claims.runId ||
    bundleHash !== claims.bundleHash ||
    idempotencyKey !== expectedIdempotencyKey ||
    body.run_id !== claims.runId ||
    body.bundle_hash !== claims.bundleHash
  ) {
    reject("Callback identifiers do not match");
  }

  return {
    runId: claims.runId,
    bundleHash: claims.bundleHash,
    result: body.result,
    claims,
  };
}

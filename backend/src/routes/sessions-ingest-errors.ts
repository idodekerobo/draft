import { serviceClient } from "../db/client";
import { resolveIngestCredentialScope } from "../credentials/session-ingest-token";
import { recordError } from "../errors/record-error";

const MAX_BODY_BYTES = 1024;
const MAX_FIELD_CHARS = 200;
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

const KNOWN_CODES = new Set([
  "placeholder-config",
  "missing-config",
  "missing-transcript",
  "missing-git-email",
  "missing-token",
  "upload-failed",
  "upload-timeout",
  "draft-binary-failed",
]);
const HTTP_CODE = /^http-[1-5]\d\d$/;

type SessionsIngestErrorsRequest = Bun.BunRequest<"/sessions/ingest-errors">;

// Per-instance and best-effort: it caps a flood from one address, not a
// distributed one. Unauthenticated callers can reach this route.
const hits = new Map<string, number[]>();

function allowRequest(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  return true;
}

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function field(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

/** Capture-hook failure reports. Never changes the hook's outcome: always a fast 202/4xx. */
export const POST = async (req: SessionsIngestErrorsRequest): Promise<Response> => {
  if (!allowRequest(clientKey(req))) return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ ok: false, error: "body_too_large" }, { status: 413 });

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const code = field(body.code);
  if (!code || !(KNOWN_CODES.has(code) || HTTP_CODE.test(code))) {
    return Response.json({ ok: false, error: "unknown_code" }, { status: 400 });
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const scope = token ? await resolveIngestCredentialScope(serviceClient, token) : null;

  const detail: Record<string, unknown> = {
    source: scope ? "client" : "client_unauthenticated",
    reason: field(body.reason),
    script_version: field(body.scriptVersion),
    os: field(body.os),
    hook_reason: field(body.hookReason),
  };
  // A claimed workspace id is never trusted as the owner of the row.
  if (!scope) detail.claimed_workspace_id = field(body.workspaceId);
  else detail.credential_id = scope.credentialId;

  void recordError({
    workspaceId: scope?.workspaceId ?? null,
    allowUnattributed: true,
    operation: "ingestion",
    message: `Session capture hook failed: ${code}`,
    code,
    detail,
  });
  return Response.json({ ok: true }, { status: 202 });
};

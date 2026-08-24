import type { SupabaseClient } from "@supabase/supabase-js";
import type { ErrorOperation } from "../types/enums";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "authorization", "cookie", "cookies", "password", "passwords", "secret", "secrets",
  "token", "tokens", "access_token", "refresh_token", "api_token", "api_key",
  "signing_secret", "webhook_secret", "credential", "credentials",
  "provider_payload", "request_body", "response_body",
]);
const SENSITIVE_QUERY = /([?&](?:token|key|secret|signature|sig|expires|credential|x-amz-[^=]+|x-goog-[^=]+)=)[^&#\s]+/gi;

export interface RecordErrorInput {
  workspaceId: string | null;
  operation: ErrorOperation;
  message: string;
  error?: unknown;
  code?: string;
  detail?: Record<string, unknown>;
  sourceConnectionId?: string | null;
  scheduledTaskId?: string | null;
  synthesisRunId?: string | null;
  client?: SupabaseClient;
}

function redactString(value: string): string {
  return value
    .replace(SENSITIVE_QUERY, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/((?:token|secret|password|credential|api[-_]?key|authorization)\s*[=:]\s*)[^\s,;}&#]+/gi, `$1${REDACTED}`)
    .replace(/\b(credentials?|tokens?|secrets?|passwords?)\s+[^\s,;}&#]+/gi, `$1 ${REDACTED}`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, seen);
  }
  return result;
}

function normalizeError(error: unknown): { metadata?: Record<string, unknown>; stack?: string } {
  if (error === undefined) return {};
  if (typeof error === "object" && error !== null) {
    const source = error as Record<string, unknown>;
    const metadata: Record<string, unknown> = {};
    const copyString = (key: string, outputKey = key) => {
      const value = source[key];
      if (typeof value === "string") metadata[outputKey] = redactString(value);
    };
    copyString("name");
    copyString("message");
    copyString("code");
    copyString("hint");
    copyString("details");
    for (const key of ["status", "statusCode", "status_code"]) {
      const value = source[key];
      if (typeof value === "string") metadata[key] = redactString(value);
      else if (typeof value === "number") metadata[key] = value;
    }
    return {
      metadata,
      stack: error instanceof Error && error.stack ? redactString(error.stack) : undefined,
    };
  }
  return { metadata: { value: sanitize(error) } };
}

function fallback(input: RecordErrorInput, reason: unknown): void {
  const normalized = normalizeError(reason);
  const original = normalizeError(input.error);
  console.error(JSON.stringify({
    event: "error_recording_fallback",
    workspace_id: input.workspaceId,
    operation: input.operation,
    code: input.code ?? null,
    source_connection_id: input.sourceConnectionId ?? null,
    scheduled_task_id: input.scheduledTaskId ?? null,
    synthesis_run_id: input.synthesisRunId ?? null,
    message: redactString(input.message),
    detail: sanitize(input.detail ?? {}),
    error: original.metadata ?? null,
    stack_trace: original.stack ?? null,
    logger_error: normalized.metadata ?? null,
  }));
}

/** Best-effort persistent operational error logging. This function never rejects. */
export async function recordError(input: RecordErrorInput): Promise<void> {
  if (!input.workspaceId) {
    fallback(input, "workspace_id_unavailable");
    return;
  }
  try {
    const normalized = normalizeError(input.error);
    const detail = sanitize({ ...(input.detail ?? {}), ...(input.code ? { code: input.code } : {}), ...(normalized.metadata ? { error: normalized.metadata } : {}) }) as Record<string, unknown>;
    // Resolve lazily so importing the recorder does not require runtime DB env
    // vars in unit tests or startup paths that only use stderr fallback.
    const client = input.client ?? (await import("../db/client")).serviceClient;
    const { error } = await client.from("errors").insert({
      workspace_id: input.workspaceId,
      source_connection_id: input.sourceConnectionId ?? null,
      scheduled_task_id: input.scheduledTaskId ?? null,
      synthesis_run_id: input.synthesisRunId ?? null,
      operation: input.operation,
      message: redactString(input.message),
      detail_json: detail,
      stack_trace: normalized.stack ?? null,
    });
    if (error) fallback(input, error);
  } catch (error) {
    fallback(input, error);
  }
}

export const errorSanitizerForTests = { redactString, sanitize, normalizeError };

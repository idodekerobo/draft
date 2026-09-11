import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CredentialError,
  resolveProviderCredentialById,
} from "../../credentials/resolve-provider-credential";
import type { SourceConnectionRow } from "../../types/tables";
import { readBoundedBody } from "../shared/read-bounded-body";

export const DEFAULT_GRANOLA_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
// Replay-protection window Granola's own docs recommend for webhook-timestamp.
const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;

export interface AuthenticateGranolaWebhookRequestOptions {
  maxBodyBytes?: number;
  now?: () => number;
}

export interface AuthenticatedGranolaWebhookRequest {
  connection: Pick<SourceConnectionRow, "id" | "workspace_id" | "connected_by_user_id">;
  credentialId: string;
  eventId: string;
  eventType: string;
  noteId: string;
}

export class GranolaWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GranolaWebhookAuthError";
  }
}

function reject(message: string): never {
  throw new GranolaWebhookAuthError(message);
}

interface GranolaWebhookPayload {
  event_id: string;
  event_type: string;
  note_id: string;
  occurred_at?: string;
}

function parseBody(bytes: Uint8Array): GranolaWebhookPayload {
  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source) as unknown;
  } catch {
    return reject("Granola webhook body is invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("Granola webhook body is invalid");
  }

  const body = parsed as Record<string, unknown>;
  if (typeof body.event_id !== "string" || body.event_id.length === 0) {
    return reject("Granola webhook event_id is invalid");
  }
  if (typeof body.event_type !== "string" || body.event_type.length === 0) {
    return reject("Granola webhook event_type is invalid");
  }
  if (typeof body.note_id !== "string" || body.note_id.length === 0) {
    return reject("Granola webhook note_id is invalid");
  }

  return body as unknown as GranolaWebhookPayload;
}

/**
 * Verifies a Standard Webhooks signature: HMAC-SHA256 of
 * "{webhook-id}.{webhook-timestamp}.{body}", keyed by the base64-decoded
 * secret, checked against the "v1,<sig>" webhook-signature header.
 */
function verifySignature(
  webhookId: string | null,
  webhookTimestamp: string | null,
  webhookSignature: string | null,
  signingSecret: string,
  bodyBytes: Uint8Array,
  now: () => number,
): void {
  if (!webhookId) reject("Granola webhook-id header is missing");
  if (!webhookTimestamp) reject("Granola webhook-timestamp header is missing");
  if (!webhookSignature) reject("Granola webhook-signature header is missing");

  const timestampSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) reject("Granola webhook-timestamp header is malformed");
  const ageSeconds = Math.abs(now() / 1000 - timestampSeconds);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) reject("Granola webhook-timestamp is too old");

  if (!signingSecret.startsWith("whsec_")) reject("Granola webhook signing secret is malformed");
  const key = Buffer.from(signingSecret.slice("whsec_".length), "base64");
  const signedContent = `${webhookId}.${webhookTimestamp}.${Buffer.from(bodyBytes).toString("utf8")}`;
  const expected = Buffer.from(createHmac("sha256", key).update(signedContent, "utf8").digest("base64"));

  const matched = webhookSignature.split(" ").some((versioned) => {
    const [version, signature = ""] = versioned.split(",");
    if (version !== "v1") return false;
    const provided = Buffer.from(signature);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  });
  if (!matched) reject("Granola webhook signature is invalid");
}

/**
 * Resolves and verifies a Granola webhook delivery by connection key. Every
 * failure surfaces as GranolaWebhookAuthError so callers can map it to a
 * bare 401 without leaking which check failed.
 */
export async function authenticateGranolaWebhookRequest(
  request: Request,
  connectionKey: string,
  client?: SupabaseClient,
  options: AuthenticateGranolaWebhookRequestOptions = {},
): Promise<AuthenticatedGranolaWebhookRequest> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const maximum = options.maxBodyBytes ?? DEFAULT_GRANOLA_WEBHOOK_BODY_LIMIT_BYTES;
  const now = options.now ?? Date.now;

  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id, credential_id, connected_by_user_id")
    .eq("connection_key", connectionKey)
    .eq("provider", "granola")
    .in("status", ["active", "degraded"])
    .maybeSingle();
  if (error) reject("Granola webhook connection lookup failed");

  const connection = data as Pick<
    SourceConnectionRow,
    "id" | "workspace_id" | "credential_id" | "connected_by_user_id"
  > | null;
  if (!connection || !connection.credential_id) {
    reject(`Granola webhook has no matching connection for key "${connectionKey}"`);
  }

  let webhookSecret: string;
  try {
    const resolved = await resolveProviderCredentialById(
      connection.workspace_id,
      "granola",
      connection.credential_id,
      db,
    );
    webhookSecret = resolved.webhook_secret;
  } catch (cause) {
    if (cause instanceof CredentialError) {
      return reject(`Granola webhook credential resolution failed: ${cause.message}`);
    }
    throw cause;
  }

  const bodyBytes = await readBoundedBody(request, maximum, () => reject("Granola webhook body is too large"));
  verifySignature(
    request.headers.get("webhook-id"),
    request.headers.get("webhook-timestamp"),
    request.headers.get("webhook-signature"),
    webhookSecret,
    bodyBytes,
    now,
  );

  const body = parseBody(bodyBytes);

  return {
    connection: {
      id: connection.id,
      workspace_id: connection.workspace_id,
      connected_by_user_id: connection.connected_by_user_id,
    },
    credentialId: connection.credential_id,
    eventId: body.event_id,
    eventType: body.event_type,
    noteId: body.note_id,
  };
}

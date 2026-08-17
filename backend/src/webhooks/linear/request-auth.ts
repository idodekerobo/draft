import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialError, resolveProviderCredential } from "../../credentials/resolve-provider-credential";
import type { SourceConnectionRow } from "../../types/tables";
import { readBoundedBody } from "../shared/read-bounded-body";
import type { LinearWebhookPayload } from "../../ingestion/linear/normalize";

export const DEFAULT_LINEAR_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface AuthenticateLinearWebhookRequestOptions {
  maxBodyBytes?: number;
}

export interface AuthenticatedLinearWebhookRequest {
  connection: Pick<SourceConnectionRow, "id" | "workspace_id">;
  payload: LinearWebhookPayload;
}

// Guards against replay of a captured payload.
const MAX_TIMESTAMP_SKEW_MS = 60 * 1000;

export class LinearWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearWebhookAuthError";
  }
}

function reject(message: string): never {
  throw new LinearWebhookAuthError(message);
}

function parseBody(bytes: Uint8Array): LinearWebhookPayload {
  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source) as unknown;
  } catch {
    return reject("Linear webhook body is invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("Linear webhook body is invalid");
  }

  const body = parsed as Record<string, unknown>;
  if (typeof body.type !== "string" || body.type.length === 0) {
    return reject("Linear webhook type is invalid");
  }
  if (typeof body.action !== "string" || body.action.length === 0) {
    return reject("Linear webhook action is invalid");
  }
  if (typeof body.data !== "object" || body.data === null) {
    return reject("Linear webhook data is invalid");
  }

  return body as unknown as LinearWebhookPayload;
}

function verifySignature(header: string | null, secret: string, bodyBytes: Uint8Array): void {
  if (!header) reject("Linear webhook signature header is missing");

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(header, "hex");
  } catch {
    return reject("Linear webhook signature header is malformed");
  }
  if (suppliedSignature.length === 0) {
    reject("Linear webhook signature header is malformed");
  }

  const expectedSignature = createHmac("sha256", secret).update(bodyBytes).digest();

  try {
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      reject("Linear webhook signature is invalid");
    }
  } catch (error) {
    if (error instanceof LinearWebhookAuthError) throw error;
    reject("Linear webhook signature is invalid");
  }
}

function verifyTimestamp(webhookTimestamp: unknown): void {
  if (typeof webhookTimestamp !== "number") {
    reject("Linear webhook timestamp is missing");
  }
  const skew = Math.abs(Date.now() - webhookTimestamp);
  if (skew > MAX_TIMESTAMP_SKEW_MS) {
    reject("Linear webhook timestamp is outside the allowed window");
  }
}

// Every failure surfaces as LinearWebhookAuthError so the route maps it to a bare 401.
export async function authenticateLinearWebhookRequest(
  request: Request,
  connectionKey: string,
  client?: SupabaseClient,
  options: AuthenticateLinearWebhookRequestOptions = {},
): Promise<AuthenticatedLinearWebhookRequest> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const maximum = options.maxBodyBytes ?? DEFAULT_LINEAR_WEBHOOK_BODY_LIMIT_BYTES;

  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id")
    .eq("connection_key", connectionKey)
    .eq("provider", "linear")
    .maybeSingle();
  if (error) reject("Linear webhook connection lookup failed");

  const connection = data as Pick<SourceConnectionRow, "id" | "workspace_id"> | null;
  if (!connection) {
    reject(`Linear webhook has no matching connection for key "${connectionKey}"`);
  }

  let webhookSecret: string;
  try {
    const credential = await resolveProviderCredential(connection.workspace_id, "linear", db);
    webhookSecret = credential.webhook_secret;
  } catch (cause) {
    if (cause instanceof CredentialError) {
      return reject(`Linear webhook credential resolution failed: ${cause.message}`);
    }
    throw cause;
  }

  const bodyBytes = await readBoundedBody(request, maximum, () => reject("Linear webhook body is too large"));
  verifySignature(request.headers.get("linear-signature"), webhookSecret, bodyBytes);

  const payload = parseBody(bodyBytes);
  verifyTimestamp(payload.webhookTimestamp);

  return { connection, payload };
}

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialError, resolveProviderCredential } from "../../credentials/resolve-provider-credential";
import type { SourceConnectionRow } from "../../types/tables";

export const DEFAULT_FIREFLIES_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface AuthenticateFirefliesWebhookRequestOptions {
  maxBodyBytes?: number;
}

export interface AuthenticatedFirefliesWebhookRequest {
  connection: Pick<SourceConnectionRow, "id" | "workspace_id">;
  event: string;
  meetingId: string;
}

export class FirefliesWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirefliesWebhookAuthError";
  }
}

function reject(message: string): never {
  throw new FirefliesWebhookAuthError(message);
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
        reject("Fireflies webhook body is too large");
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

interface FirefliesWebhookPayload {
  event: string;
  meeting_id: string;
  timestamp?: string;
  client_reference_id?: string;
}

function parseBody(bytes: Uint8Array): FirefliesWebhookPayload {
  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source) as unknown;
  } catch {
    return reject("Fireflies webhook body is invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("Fireflies webhook body is invalid");
  }

  const body = parsed as Record<string, unknown>;
  if (typeof body.event !== "string" || body.event.length === 0) {
    return reject("Fireflies webhook event is invalid");
  }
  if (typeof body.meeting_id !== "string" || body.meeting_id.length === 0) {
    return reject("Fireflies webhook meeting_id is invalid");
  }

  return body as unknown as FirefliesWebhookPayload;
}

function verifySignature(header: string | null, secret: string, bodyBytes: Uint8Array): void {
  if (!header) reject("Fireflies webhook signature header is missing");

  const match = header.match(/^sha256=([0-9a-f]+)$/i);
  if (!match) reject("Fireflies webhook signature header is malformed");

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(match[1], "hex");
  } catch {
    return reject("Fireflies webhook signature header is malformed");
  }
  if (suppliedSignature.length === 0) {
    reject("Fireflies webhook signature header is malformed");
  }

  const expectedSignature = createHmac("sha256", secret).update(bodyBytes).digest();

  try {
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      reject("Fireflies webhook signature is invalid");
    }
  } catch (error) {
    if (error instanceof FirefliesWebhookAuthError) throw error;
    reject("Fireflies webhook signature is invalid");
  }
}

// Every failure mode surfaces as the same FirefliesWebhookAuthError so the
// route can map it uniformly to a bare 401 without leaking which check failed.
export async function authenticateFirefliesWebhookRequest(
  request: Request,
  connectionKey: string,
  client?: SupabaseClient,
  options: AuthenticateFirefliesWebhookRequestOptions = {},
): Promise<AuthenticatedFirefliesWebhookRequest> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const maximum = options.maxBodyBytes ?? DEFAULT_FIREFLIES_WEBHOOK_BODY_LIMIT_BYTES;

  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id")
    .eq("connection_key", connectionKey)
    .eq("provider", "fireflies")
    .maybeSingle();
  if (error) reject("Fireflies webhook connection lookup failed");

  const connection = data as Pick<SourceConnectionRow, "id" | "workspace_id"> | null;
  if (!connection) {
    reject(`Fireflies webhook has no matching connection for key "${connectionKey}"`);
  }

  let webhookSecret: string;
  try {
    const credential = await resolveProviderCredential(connection.workspace_id, "fireflies", db);
    webhookSecret = credential.webhook_secret;
  } catch (cause) {
    if (cause instanceof CredentialError) {
      return reject(`Fireflies webhook credential resolution failed: ${cause.message}`);
    }
    throw cause;
  }

  const bodyBytes = await readBoundedBody(request, maximum);
  verifySignature(request.headers.get("x-hub-signature"), webhookSecret, bodyBytes);

  const body = parseBody(bodyBytes);

  return {
    connection,
    event: body.event,
    meetingId: body.meeting_id,
  };
}

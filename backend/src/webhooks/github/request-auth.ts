import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceConnectionRow } from "../../types/tables";
import { readBoundedBody } from "../shared/read-bounded-body";
import { loadConfig } from "../../config";

// GitHub push payloads can carry many commits, larger than a single Linear event.
export const DEFAULT_GITHUB_WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export class GithubWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookAuthError";
  }
}

function reject(message: string): never {
  throw new GithubWebhookAuthError(message);
}

function verifySignature(header: string | null, secret: string, bodyBytes: Uint8Array): void {
  if (!header || !header.startsWith("sha256=")) {
    reject("GitHub webhook signature header is missing or malformed");
  }

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return reject("GitHub webhook signature header is malformed");
  }
  if (suppliedSignature.length === 0) reject("GitHub webhook signature header is malformed");

  const expectedSignature = createHmac("sha256", secret).update(bodyBytes).digest();
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    reject("GitHub webhook signature is invalid");
  }
}

export interface AuthenticatedGithubWebhookRequest {
  eventType: string;
  payload: Record<string, unknown>;
  connection: Pick<SourceConnectionRow, "id" | "workspace_id"> | null;
}

// Order is reversed vs Linear: verify signature first (no connection lookup
// needed yet, since GitHub's one App-level secret isn't per-connection),
// then parse body, then resolve installation.id -> source_connections.
export async function authenticateGithubWebhookRequest(
  request: Request,
  client?: SupabaseClient,
  options: { maxBodyBytes?: number } = {},
): Promise<AuthenticatedGithubWebhookRequest> {
  const config = loadConfig();
  const maximum = options.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_BODY_LIMIT_BYTES;

  const bodyBytes = await readBoundedBody(request, maximum, () => reject("GitHub webhook body is too large"));
  verifySignature(request.headers.get("x-hub-signature-256"), config.githubAppWebhookSecret, bodyBytes);

  const eventType = request.headers.get("x-github-event");
  if (!eventType) reject("GitHub webhook is missing X-GitHub-Event header");

  let payload: Record<string, unknown>;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    payload = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return reject("GitHub webhook body is invalid JSON");
  }

  const installation = payload.installation as { id?: number } | undefined;
  if (!installation?.id) {
    // App-level ping (and any payload without installation context) has no connection to resolve.
    return { eventType, payload, connection: null };
  }

  const db = client ?? (await import("../../db/client")).serviceClient;
  const { data, error } = await db
    .from("source_connections")
    .select("id, workspace_id")
    .eq("connection_key", String(installation.id))
    .eq("provider", "github")
    .in("status", ["active", "degraded"])
    .maybeSingle();
  if (error) reject("GitHub webhook connection lookup failed");

  return { eventType, payload, connection: data as Pick<SourceConnectionRow, "id" | "workspace_id"> | null };
}

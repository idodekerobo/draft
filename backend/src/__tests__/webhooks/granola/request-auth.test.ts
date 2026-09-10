import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredentialPayload } from "../../../credentials/crypto";
import {
  authenticateGranolaWebhookRequest,
  DEFAULT_GRANOLA_WEBHOOK_BODY_LIMIT_BYTES,
  GranolaWebhookAuthError,
} from "../../../webhooks/granola/request-auth";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  connection: "22222222-2222-4222-8222-222222222222",
  credential: "33333333-3333-4333-8333-333333333333",
};

const KEY_VERSION = "v1";
const CONNECTION_KEY = "acme-granola";
// A real signing secret is "whsec_" + base64(random key bytes).
const SIGNING_SECRET = `whsec_${Buffer.from("granola-secret-key-bytes").toString("base64")}`;
const FIXED_NOW = 1_769_527_800_000; // 2026-01-27T15:30:00.000Z

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeClientOptions {
  connection?: { id: string; workspace_id: string; credential_id: string | null; connected_by_user_id?: string | null } | null;
  credential?: {
    id: string;
    status: string;
    expires_at: string | null;
    encrypted_payload: unknown;
    encryption_key_version: string;
  } | null;
  connectionCredentialId?: string | null;
  connectionStatus?: string;
}

function createFakeClient(options: FakeClientOptions) {
  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => {
              const maybeSingle = async () => ({
                data:
                  options.connection === undefined
                    ? {
                        id: ids.connection,
                        workspace_id: ids.workspace,
                        credential_id: options.connectionCredentialId ?? ids.credential,
                        connected_by_user_id: null,
                      }
                    : options.connection,
                error: null,
              });
              return {
                maybeSingle,
                in: (_column: string, statuses: string[]) => ({
                  maybeSingle: async () => statuses.includes(options.connectionStatus ?? "active")
                    ? maybeSingle()
                    : { data: null, error: null },
                }),
              };
            },
          }),
        }),
      };
    }
    if (table === "credentials") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: (providerColumn: string, providerValue: unknown) => ({
                maybeSingle: async () => ({
                  data: providerColumn === "provider" && providerValue === "granola"
                    ? options.credential ?? null
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }
  return { from } as unknown as SupabaseClient;
}

function activeCredential(payload: unknown) {
  return { id: ids.credential, status: "active", expires_at: null, encrypted_payload: payload, encryption_key_version: KEY_VERSION };
}

function defaultClient(secret = SIGNING_SECRET) {
  return createFakeClient({
    credential: activeCredential(
      encryptCredentialPayload(
        JSON.stringify({ api_token: "grn_token", webhook_secret: secret, webhook_endpoint_id: "whe_1" }),
        KEY_VERSION,
      ),
    ),
  });
}

function sign(body: string, id: string, timestamp: string, secret: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signedContent = `${id}.${timestamp}.${body}`;
  const digest = createHmac("sha256", key).update(signedContent, "utf8").digest("base64");
  return `v1,${digest}`;
}

function makeRequest(
  body: string,
  { id, timestamp, signature }: { id?: string | null; timestamp?: string | null; signature?: string | null },
): Request {
  const headers = new Headers();
  if (id !== null) headers.set("webhook-id", id ?? "evt_123");
  if (timestamp !== null) headers.set("webhook-timestamp", timestamp ?? String(Math.floor(FIXED_NOW / 1000)));
  if (signature !== null) headers.set("webhook-signature", signature ?? "");
  return new Request("https://example.com/webhooks/granola/acme-granola", { method: "POST", headers, body });
}

const validPayload = JSON.stringify({ event_id: "evt_123", event_type: "note.generated", note_id: "not_123" });
const nowFixed = () => FIXED_NOW;

describe("authenticateGranolaWebhookRequest", () => {
  it("succeeds with a valid signature and returns connection/event/noteId", async () => {
    const client = defaultClient();
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const signature = sign(validPayload, "evt_123", timestamp, SIGNING_SECRET);
    const request = makeRequest(validPayload, { timestamp, signature });

    const result = await authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed });

    expect(result).toEqual({
      connection: { id: ids.connection, workspace_id: ids.workspace, connected_by_user_id: null },
      credentialId: ids.credential,
      eventId: "evt_123",
      eventType: "note.generated",
      noteId: "not_123",
    });
  });

  it("rejects a wrong signature", async () => {
    const client = defaultClient();
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const signature = sign(validPayload, "evt_123", timestamp, `whsec_${Buffer.from("wrong-key").toString("base64")}`);
    const request = makeRequest(validPayload, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects missing headers", async () => {
    const client = defaultClient();
    const request = makeRequest(validPayload, { id: null, timestamp: null, signature: null });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects a stale webhook-timestamp (replay protection)", async () => {
    const client = defaultClient();
    const staleTimestamp = String(Math.floor(FIXED_NOW / 1000) - 60 * 60); // 1 hour old
    const signature = sign(validPayload, "evt_123", staleTimestamp, SIGNING_SECRET);
    const request = makeRequest(validPayload, { timestamp: staleTimestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects an unknown connection_key", async () => {
    const client = createFakeClient({ connection: null });
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const signature = sign(validPayload, "evt_123", timestamp, SIGNING_SECRET);
    const request = makeRequest(validPayload, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, "unknown-key", client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it.each(["pending", "error", "revoked"])(
    "rejects an inactive %s connection exactly like a missing key",
    async (connectionStatus) => {
      const client = createFakeClient({ connectionStatus });
      const timestamp = String(Math.floor(FIXED_NOW / 1000));
      const signature = sign(validPayload, "evt_123", timestamp, SIGNING_SECRET);
      const request = makeRequest(validPayload, { timestamp, signature });

      await expect(
        authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
      ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
    },
  );

  it("rejects a tampered body (bit-flip after signing)", async () => {
    const client = defaultClient();
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const signature = sign(validPayload, "evt_123", timestamp, SIGNING_SECRET);
    const tampered = JSON.stringify({ event_id: "evt_123", event_type: "note.generated", note_id: "not_999" });
    const request = makeRequest(tampered, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects malformed JSON after a valid signature", async () => {
    const client = defaultClient();
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const body = "not json";
    const signature = sign(body, "evt_123", timestamp, SIGNING_SECRET);
    const request = makeRequest(body, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects a body larger than the configured max size", async () => {
    const client = defaultClient();
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const bigBody = JSON.stringify({
      event_id: "evt_123",
      event_type: "note.generated",
      note_id: "x".repeat(DEFAULT_GRANOLA_WEBHOOK_BODY_LIMIT_BYTES),
    });
    const signature = sign(bigBody, "evt_123", timestamp, SIGNING_SECRET);
    const request = makeRequest(bigBody, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed, maxBodyBytes: 1024 }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });

  it("rejects when the credential cannot be resolved", async () => {
    const client = createFakeClient({ credential: null });
    const timestamp = String(Math.floor(FIXED_NOW / 1000));
    const signature = sign(validPayload, "evt_123", timestamp, SIGNING_SECRET);
    const request = makeRequest(validPayload, { timestamp, signature });

    await expect(
      authenticateGranolaWebhookRequest(request, CONNECTION_KEY, client, { now: nowFixed }),
    ).rejects.toBeInstanceOf(GranolaWebhookAuthError);
  });
});

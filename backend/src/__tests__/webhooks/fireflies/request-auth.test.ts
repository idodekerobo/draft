import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredentialPayload } from "../../../credentials/crypto";
import {
  authenticateFirefliesWebhookRequest,
  DEFAULT_FIREFLIES_WEBHOOK_BODY_LIMIT_BYTES,
  FirefliesWebhookAuthError,
} from "../../../webhooks/fireflies/request-auth";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  connection: "22222222-2222-4222-8222-222222222222",
  credential: "33333333-3333-4333-8333-333333333333",
};

const KEY_VERSION = "v1";
const CONNECTION_KEY = "acme-fireflies";
const WEBHOOK_SECRET = "ff-webhook-secret";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeClientOptions {
  connection?: { id: string; workspace_id: string; credential_id: string | null } | null;
  credential?: {
    id: string;
    status: string;
    expires_at: string | null;
    encrypted_payload: unknown;
    encryption_key_version: string;
  } | null;
  connectionCredentialId?: string | null;
  connectionStatus?: string;
  expectedCredentialId?: string;
}

function createFakeClient(options: FakeClientOptions) {
  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: (columns: string) => ({
          eq: () => ({
            eq: () => {
              const maybeSingle = async () => {
                return {
                  data:
                    options.connection === undefined
                      ? {
                          id: ids.connection,
                          workspace_id: ids.workspace,
                          credential_id: options.connectionCredentialId ?? ids.credential,
                        }
                      : options.connection,
                  error: null,
                };
              };
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
          eq: (column: string, value: unknown) => {
            if (column === "id" && options.expectedCredentialId) {
              expect(value).toBe(options.expectedCredentialId);
            }
            return {
              eq: () => ({
                eq: (providerColumn: string, providerValue: unknown) => ({
                  maybeSingle: async () => ({
                    data: providerColumn === "provider" && providerValue === "fireflies"
                      ? options.credential ?? null
                      : null,
                    error: null,
                  }),
                }),
              }),
            };
          },
        }),
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { from } as unknown as SupabaseClient;
}

function activeCredential(payload: unknown) {
  return {
    id: ids.credential,
    status: "active",
    expires_at: null,
    encrypted_payload: payload,
    encryption_key_version: KEY_VERSION,
  };
}

function defaultClient(secret = WEBHOOK_SECRET) {
  return createFakeClient({
    credential: activeCredential(
      encryptCredentialPayload(
        JSON.stringify({ api_token: "ff-token", webhook_secret: secret }),
        KEY_VERSION,
      ),
    ),
  });
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeRequest(body: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) headers.set("x-hub-signature", signature);
  return new Request("https://example.com/webhooks/fireflies/acme-fireflies", {
    method: "POST",
    headers,
    body,
  });
}

const validPayload = JSON.stringify({ event: "meeting.summarized", meeting_id: "meeting-123" });

describe("authenticateFirefliesWebhookRequest", () => {
  it("succeeds with a valid signature and returns connection/event/meetingId", async () => {
    const client = defaultClient();
    const request = makeRequest(validPayload, sign(validPayload, WEBHOOK_SECRET));

    const result = await authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client);

    expect(result).toEqual({
      connection: { id: ids.connection, workspace_id: ids.workspace },
      credentialId: ids.credential,
      event: "meeting.summarized",
      meetingId: "meeting-123",
    });
  });

  it("decrypts the exact credential generation captured with the connection", async () => {
    const capturedCredentialId = "44444444-4444-4444-8444-444444444444";
    const capturedSecret = "captured-generation-secret";
    const client = createFakeClient({
      connection: {
        id: ids.connection,
        workspace_id: ids.workspace,
        credential_id: capturedCredentialId,
      },
      expectedCredentialId: capturedCredentialId,
      credential: {
        ...activeCredential(
          encryptCredentialPayload(
            JSON.stringify({ api_token: "ff-token", webhook_secret: capturedSecret }),
            KEY_VERSION,
          ),
        ),
        id: capturedCredentialId,
      },
    });
    const request = makeRequest(validPayload, sign(validPayload, capturedSecret));

    const result = await authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client);

    expect(result.credentialId).toBe(capturedCredentialId);
  });

  it("rejects a wrong signature", async () => {
    const client = defaultClient();
    const request = makeRequest(validPayload, sign(validPayload, "some-other-secret"));

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects a missing signature header", async () => {
    const client = defaultClient();
    const request = makeRequest(validPayload, null);

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects an unknown connection_key", async () => {
    const client = createFakeClient({ connection: null });
    const request = makeRequest(validPayload, sign(validPayload, WEBHOOK_SECRET));

    await expect(
      authenticateFirefliesWebhookRequest(request, "unknown-key", client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it.each(["pending", "error", "revoked"])(
    "rejects an inactive %s connection exactly like a missing key",
    async (connectionStatus) => {
      const client = createFakeClient({ connectionStatus });
      const request = makeRequest(validPayload, sign(validPayload, WEBHOOK_SECRET));

      await expect(
        authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
      ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
    },
  );

  it("rejects a tampered body (bit-flip after signing)", async () => {
    const client = defaultClient();
    const signature = sign(validPayload, WEBHOOK_SECRET);
    const tampered = JSON.stringify({ event: "meeting.summarized", meeting_id: "meeting-999" });
    const request = makeRequest(tampered, signature);

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects malformed JSON after a valid signature", async () => {
    const client = defaultClient();
    const body = "not json";
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET));

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects a body missing required fields after a valid signature", async () => {
    const client = defaultClient();
    const body = JSON.stringify({ event: "meeting.summarized" });
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET));

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects a body larger than the configured max size", async () => {
    const client = defaultClient();
    const bigBody = JSON.stringify({
      event: "meeting.summarized",
      meeting_id: "x".repeat(DEFAULT_FIREFLIES_WEBHOOK_BODY_LIMIT_BYTES),
    });
    const request = makeRequest(bigBody, sign(bigBody, WEBHOOK_SECRET));

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client, {
        maxBodyBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });

  it("rejects when the credential cannot be resolved", async () => {
    const client = createFakeClient({ credential: null });
    const request = makeRequest(validPayload, sign(validPayload, WEBHOOK_SECRET));

    await expect(
      authenticateFirefliesWebhookRequest(request, CONNECTION_KEY, client),
    ).rejects.toBeInstanceOf(FirefliesWebhookAuthError);
  });
});

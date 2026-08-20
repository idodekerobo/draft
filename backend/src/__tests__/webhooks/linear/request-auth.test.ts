import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredentialPayload } from "../../../credentials/crypto";
import {
  authenticateLinearWebhookRequest,
  LinearWebhookAuthError,
} from "../../../webhooks/linear/request-auth";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  connection: "22222222-2222-4222-8222-222222222222",
  credential: "33333333-3333-4333-8333-333333333333",
};

const KEY_VERSION = "v1";
const CONNECTION_KEY = "acme-linear";
const WEBHOOK_SECRET = "linear-webhook-secret";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeClientOptions {
  connection?: { id: string; workspace_id: string } | null;
  connectionStatus?: string;
  credential?: {
    id: string;
    status: string;
    expires_at: string | null;
    encrypted_payload: unknown;
    encryption_key_version: string;
  } | null;
}

function createFakeClient(options: FakeClientOptions = {}) {
  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: (columns: string) => ({
          eq: () => ({
            eq: () => {
              const connection = options.connection === undefined
                ? { id: ids.connection, workspace_id: ids.workspace }
                : options.connection;
              const status = options.connectionStatus ?? "active";
              const maybeSingle = async () => ({
                data: columns.includes("credential_id")
                  ? {
                      id: ids.connection,
                      credential_id: ids.credential,
                      status,
                    }
                  : connection,
                error: null,
              });

              return {
                maybeSingle,
                in: (_column: string, statuses: string[]) => ({
                  maybeSingle: async () => statuses.includes(status)
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
              eq: () => ({
                maybeSingle: async () => ({ data: options.credential ?? null, error: null }),
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

function defaultClient(secret = WEBHOOK_SECRET) {
  return createFakeClient({
    credential: {
      id: ids.credential,
      status: "active",
      expires_at: null,
      encrypted_payload: encryptCredentialPayload(
        JSON.stringify({ api_token: "linear-token", webhook_secret: secret }),
        KEY_VERSION,
      ),
      encryption_key_version: KEY_VERSION,
    },
  });
}

function makePayload(timestamp = Date.now()): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    webhookTimestamp: timestamp,
    data: { id: "issue-1", title: "Ship lifecycle guards" },
  });
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(body: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) headers.set("linear-signature", signature);
  return new Request(`https://example.com/webhooks/linear/${CONNECTION_KEY}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("authenticateLinearWebhookRequest", () => {
  it("returns the connection and payload for a valid signed request", async () => {
    const body = makePayload();

    const result = await authenticateLinearWebhookRequest(
      makeRequest(body, sign(body)),
      CONNECTION_KEY,
      defaultClient(),
    );

    expect(result.connection).toEqual({ id: ids.connection, workspace_id: ids.workspace });
    expect(result.payload.type).toBe("Issue");
    expect(result.payload.action).toBe("update");
  });

  it("rejects missing and invalid signatures", async () => {
    const body = makePayload();

    await expect(
      authenticateLinearWebhookRequest(makeRequest(body, null), CONNECTION_KEY, defaultClient()),
    ).rejects.toBeInstanceOf(LinearWebhookAuthError);
    await expect(
      authenticateLinearWebhookRequest(
        makeRequest(body, sign(body, "wrong-secret")),
        CONNECTION_KEY,
        defaultClient(),
      ),
    ).rejects.toBeInstanceOf(LinearWebhookAuthError);
  });

  it("rejects malformed bodies and stale timestamps after signature verification", async () => {
    const malformed = "not-json";
    await expect(
      authenticateLinearWebhookRequest(
        makeRequest(malformed, sign(malformed)),
        CONNECTION_KEY,
        defaultClient(),
      ),
    ).rejects.toBeInstanceOf(LinearWebhookAuthError);

    const stale = makePayload(Date.now() - 61_000);
    await expect(
      authenticateLinearWebhookRequest(
        makeRequest(stale, sign(stale)),
        CONNECTION_KEY,
        defaultClient(),
      ),
    ).rejects.toBeInstanceOf(LinearWebhookAuthError);
  });

  it("rejects an unknown connection key", async () => {
    const body = makePayload();
    const client = createFakeClient({ connection: null });

    await expect(
      authenticateLinearWebhookRequest(makeRequest(body, sign(body)), "unknown", client),
    ).rejects.toBeInstanceOf(LinearWebhookAuthError);
  });

  it.each(["pending", "error", "revoked"])(
    "rejects an inactive %s connection exactly like a missing key",
    async (connectionStatus) => {
      const body = makePayload();
      const client = createFakeClient({ connectionStatus });

      await expect(
        authenticateLinearWebhookRequest(makeRequest(body, sign(body)), CONNECTION_KEY, client),
      ).rejects.toBeInstanceOf(LinearWebhookAuthError);
    },
  );
});

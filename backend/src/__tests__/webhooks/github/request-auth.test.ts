import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authenticateGithubWebhookRequest,
  GithubWebhookAuthError,
} from "../../../webhooks/github/request-auth";

const WEBHOOK_SECRET = "gh-webhook-secret";
const INSTALLATION_ID = 987654;

beforeAll(() => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_SLUG = "draft-context-test";
  process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----";
  process.env.GITHUB_APP_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeRequest(body: string, signature: string | null, eventType: string | null = "pull_request"): Request {
  const headers: Record<string, string> = {};
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  if (eventType !== null) headers["x-github-event"] = eventType;
  return new Request("http://internal.test/webhooks/github", { method: "POST", headers, body });
}

function createFakeClient(connection: { id: string; workspace_id: string } | null) {
  const calls: { connectionKey: string }[] = [];
  function from(table: string) {
    if (table !== "source_connections") throw new Error(`Unexpected table: ${table}`);
    return {
      select: () => ({
        eq: (_col: string, value: string) => {
          calls.push({ connectionKey: value });
          return {
            eq: () => ({ maybeSingle: async () => ({ data: connection, error: null }) }),
          };
        },
      }),
    };
  }
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("authenticateGithubWebhookRequest", () => {
  it("rejects a missing signature header", async () => {
    const { client } = createFakeClient(null);
    const request = makeRequest("{}", null);
    await expect(authenticateGithubWebhookRequest(request, client)).rejects.toBeInstanceOf(GithubWebhookAuthError);
  });

  it("rejects a wrong signature", async () => {
    const { client } = createFakeClient(null);
    const body = JSON.stringify({ installation: { id: INSTALLATION_ID } });
    const request = makeRequest(body, sign(body, "wrong-secret"));
    await expect(authenticateGithubWebhookRequest(request, client)).rejects.toBeInstanceOf(GithubWebhookAuthError);
  });

  it("rejects a missing X-GitHub-Event header", async () => {
    const { client } = createFakeClient(null);
    const body = JSON.stringify({ installation: { id: INSTALLATION_ID } });
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET), null);
    await expect(authenticateGithubWebhookRequest(request, client)).rejects.toBeInstanceOf(GithubWebhookAuthError);
  });

  it("resolves the connection by installation.id against connection_key, not a URL segment", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const { client, calls } = createFakeClient(connection);
    const body = JSON.stringify({ installation: { id: INSTALLATION_ID }, action: "opened" });
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET));

    const result = await authenticateGithubWebhookRequest(request, client);
    expect(result.connection).toEqual(connection);
    expect(result.eventType).toBe("pull_request");
    expect(calls[0]?.connectionKey).toBe(String(INSTALLATION_ID));
  });

  it("returns connection: null for a payload with no installation field (e.g. an App-level ping)", async () => {
    const { client } = createFakeClient(null);
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET), "ping");

    const result = await authenticateGithubWebhookRequest(request, client);
    expect(result.connection).toBeNull();
  });

  it("returns connection: null (not an error) when no connection row matches yet -- the callback/webhook race", async () => {
    const { client } = createFakeClient(null);
    const body = JSON.stringify({ installation: { id: INSTALLATION_ID } });
    const request = makeRequest(body, sign(body, WEBHOOK_SECRET));

    const result = await authenticateGithubWebhookRequest(request, client);
    expect(result.connection).toBeNull();
  });
});

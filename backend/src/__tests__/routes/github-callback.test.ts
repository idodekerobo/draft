import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createInstallSession, getInstallSession, resetInstallSessionStore } from "../../auth/github-install-store";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_SLUG = "draft-context-test";
process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----";
process.env.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";

const realClientInstanceModule = await import("../../ingestion/github/client-instance");
const realUpsertModule = await import("../../ingestion/upsert-source-item");
const realDbClientModule = await import("../../db/client");

function restoreRealModules() {
  mock.module("../../ingestion/github/client-instance", () => realClientInstanceModule);
  mock.module("../../ingestion/upsert-source-item", () => realUpsertModule);
  mock.module("../../db/client", () => realDbClientModule);
}

function callbackUrl(params: Record<string, string>): string {
  const url = new URL("http://internal.test/workspaces/github/callback");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

describe("GET /workspaces/github/callback", () => {
  beforeEach(() => {
    resetInstallSessionStore();
  });

  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("upserts a connection and resolves the session on a verified install", async () => {
    const code = createInstallSession("ws-1");
    let upsertedInput: Record<string, unknown> | undefined;

    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async () => ({ accountLogin: "acme", accountId: 42, suspendedAt: null }),
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async (_client: unknown, input: Record<string, unknown>) => {
        upsertedInput = input;
        return { id: "conn-1" };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(
      new Request(callbackUrl({ installation_id: "555", setup_action: "install", state: code })),
    );

    expect(response.status).toBe(200);
    expect(upsertedInput).toMatchObject({
      workspace_id: "ws-1",
      provider: "github",
      connection_key: "555",
      status: "active",
      display_name: "acme",
      external_account_id: "42",
      credential_id: null,
    });
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
  });

  it("resolves with an error and does not upsert when setup_action is 'request' (pending owner approval)", async () => {
    const code = createInstallSession("ws-1");
    let upsertCalled = false;
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async () => {
        upsertCalled = true;
        return { id: "conn-1" };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(
      new Request(callbackUrl({ installation_id: "555", setup_action: "request", state: code })),
    );

    expect(response.status).toBe(200);
    expect(upsertCalled).toBe(false);
    const session = getInstallSession(code);
    expect(session.status).toBe("error");
    expect((session as { errorMessage?: string }).errorMessage).toContain("owner approval");
  });

  it("does not upsert when verifyInstallation rejects a spoofed installation id", async () => {
    const code = createInstallSession("ws-1");
    let upsertCalled = false;
    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async () => {
          throw new Error("404 not found");
        },
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async () => {
        upsertCalled = true;
        return { id: "conn-1" };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(
      new Request(callbackUrl({ installation_id: "999999", setup_action: "install", state: code })),
    );

    expect(response.status).toBe(200);
    expect(upsertCalled).toBe(false);
    expect(getInstallSession(code).status).toBe("error");
  });

  it("returns 400 without touching the store when state is missing", async () => {
    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({ installation_id: "555", setup_action: "install" })));
    expect(response.status).toBe(400);
  });
});

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

function mockPreflight(
  data: { connection_key: string } | null = null,
  error: Record<string, unknown> | null = null,
) {
  mock.module("../../db/client", () => ({
    serviceClient: {
      from(table: string) {
        if (table === "errors") {
          return { insert: async () => ({ error: null }) };
        }
        expect(table).toBe("source_connections");
        let selected = "";
        const filters: Array<["eq" | "neq", string, unknown]> = [];
        const builder = {
          select: (columns: string) => { selected = columns; return builder; },
          eq: (column: string, value: unknown) => { filters.push(["eq", column, value]); return builder; },
          neq: (column: string, value: unknown) => { filters.push(["neq", column, value]); return builder; },
          maybeSingle: async () => {
            expect(selected).toBe("connection_key");
            expect(filters).toEqual([
              ["eq", "workspace_id", "ws-1"],
              ["eq", "provider", "github"],
              ["neq", "status", "revoked"],
            ]);
            return { data, error };
          },
        };
        return builder;
      },
    },
  }));
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
    mockPreflight();

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
    mockPreflight();
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

  it("rejects a second live installation during preflight with disconnect-first guidance", async () => {
    const code = createInstallSession("ws-1");
    let verified = false;
    let upsertCalled = false;
    mockPreflight({ connection_key: "existing-installation" });
    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async () => {
          verified = true;
          return { accountLogin: "new-org", accountId: 42, suspendedAt: null };
        },
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async () => {
        upsertCalled = true;
        return { id: "conn-2" };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({
      installation_id: "new-installation",
      setup_action: "install",
      state: code,
    })));
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(verified).toBe(false);
    expect(upsertCalled).toBe(false);
    expect(responseText).toContain("Disconnect GitHub first");
    expect(getInstallSession(code)).toEqual({
      status: "error",
      workspaceId: "ws-1",
      errorCode: "github_installation_conflict",
      errorMessage: "A GitHub installation is already connected to this workspace. Disconnect GitHub first, then try again.",
    });
  });

  it("allows the same live installation to verify and upsert", async () => {
    const code = createInstallSession("ws-1");
    const verifiedInstallationIds: string[] = [];
    const upsertedConnectionKeys: string[] = [];
    mockPreflight({ connection_key: "same-installation" });
    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async (installationId: string) => {
          verifiedInstallationIds.push(installationId);
          return { accountLogin: "same-org", accountId: 42, suspendedAt: null };
        },
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async (_client: unknown, input: Record<string, unknown>) => {
        upsertedConnectionKeys.push(String(input.connection_key));
        return { id: "conn-1" };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({
      installation_id: "same-installation",
      setup_action: "install",
      state: code,
    })));

    expect(response.status).toBe(200);
    expect(verifiedInstallationIds).toEqual(["same-installation"]);
    expect(upsertedConnectionKeys).toEqual(["same-installation"]);
    expect(getInstallSession(code)).toEqual({ status: "connected", workspaceId: "ws-1" });
  });

  it("translates the per-workspace unique-index race to the stable conflict", async () => {
    const code = createInstallSession("ws-1");
    mockPreflight();
    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async () => ({ accountLogin: "new-org", accountId: 42, suspendedAt: null }),
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async () => {
        throw {
          code: "23505",
          message: 'duplicate key value violates unique constraint "source_connections_one_live_github_per_workspace"',
          details: "workspace conflict raw detail",
        };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({
      installation_id: "new-installation",
      setup_action: "install",
      state: code,
    })));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Disconnect GitHub first");
    expect(getInstallSession(code)).toMatchObject({
      status: "error",
      errorCode: "github_installation_conflict",
    });
  });

  it("preserves generic handling for a global installation-id conflict", async () => {
    const code = createInstallSession("ws-1");
    mockPreflight();
    mock.module("../../ingestion/github/client-instance", () => ({
      githubClient: {
        verifyInstallation: async () => ({ accountLogin: "claimed-org", accountId: 42, suspendedAt: null }),
      },
    }));
    mock.module("../../ingestion/upsert-source-item", () => ({
      upsertSourceConnection: async () => {
        throw {
          code: "23505",
          message: 'duplicate key value violates unique constraint "source_connections_github_installation_unique"',
        };
      },
    }));

    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({
      installation_id: "already-claimed",
      setup_action: "install",
      state: code,
    })));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Something went wrong connecting GitHub.");
    expect(getInstallSession(code)).toEqual({
      status: "error",
      workspaceId: "ws-1",
      errorMessage: "Something went wrong connecting GitHub.",
    });
  });

  it("returns 400 without touching the store when state is missing", async () => {
    const { GET } = await import("../../routes/github-callback");
    const response = await GET(new Request(callbackUrl({ installation_id: "555", setup_action: "install" })));
    expect(response.status).toBe(400);
  });
});

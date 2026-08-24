import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetInstallSessionStore } from "../../auth/github-install-store";

// Set before the dynamic imports below, since workspace-access.ts imports
// db/client.ts, whose module-load-time loadConfig() call needs these
// synchronously -- a beforeAll callback runs too late for that.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_SLUG = "draft-context-test";
process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----";
process.env.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";

const caller = { userId: "user-1", accessToken: "token-1" };

// Same live-binding hazard as webhooks/github/route.test.ts: restore after
// every test, not just at the end, so a sibling test file in the same run
// can't observe this file's mocked withAuth/workspace-access.
const realWithAuthModule = await import("../../auth/withAuth");
const realWorkspaceAccessModule = await import("../../auth/workspace-access");

let accessResult: Response | null = null;

function mockAuth() {
  mock.module("../../auth/withAuth", () => ({
    withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
      (request: Request) => handler(request, caller),
  }));
  mock.module("../../auth/workspace-access", () => ({
    assertWorkspaceAccess: async () => accessResult,
  }));
}

function restoreRealModules() {
  mock.module("../../auth/withAuth", () => realWithAuthModule);
  mock.module("../../auth/workspace-access", () => realWorkspaceAccessModule);
}

function bunRequest(code?: string): Bun.BunRequest<"/workspaces/:id/github/install-sessions/:code"> {
  const request = new Request("http://internal.test/workspaces/ws-1/github/install-sessions", {
    method: "POST",
  });
  return Object.assign(request, { params: { id: "ws-1", code: code ?? "" } }) as never;
}

describe("github-install routes", () => {
  beforeEach(() => {
    accessResult = null;
    resetInstallSessionStore();
    mockAuth();
  });

  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("createPOST returns a code and an installUrl built from the App slug", async () => {
    const { createPOST } = await import("../../routes/github-install");
    const response = await createPOST(bunRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: string; installUrl: string };
    expect(body.code).toMatch(/^[0-9a-f]{32}$/);
    expect(body.installUrl).toBe(
      `https://github.com/apps/draft-context-test/installations/new?state=${body.code}`,
    );
  });

  it("createPOST returns the access-denied response when workspace access is denied", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const { createPOST } = await import("../../routes/github-install");
    const response = await createPOST(bunRequest());
    expect(response.status).toBe(403);
  });

  it("pollGET returns pending for an unresolved session", async () => {
    const { createPOST, pollGET } = await import("../../routes/github-install");
    const createResponse = await createPOST(bunRequest());
    const { code } = (await createResponse.json()) as { code: string };

    const response = await pollGET(bunRequest(code));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
  });

  it("pollGET returns 404 for an unknown code", async () => {
    const { pollGET } = await import("../../routes/github-install");
    const response = await pollGET(bunRequest("nonexistent"));
    expect(response.status).toBe(404);
  });

  it("pollGET returns 403 when the session belongs to a different workspace", async () => {
    const { resolveInstallSession, createInstallSession } = await import("../../auth/github-install-store");
    const code = createInstallSession("some-other-workspace");
    resolveInstallSession(code, { status: "connected" });

    const { pollGET } = await import("../../routes/github-install");
    const response = await pollGET(bunRequest(code));
    expect(response.status).toBe(403);
  });

  it("pollGET repeatedly surfaces the same terminal error status", async () => {
    const { createInstallSession, resolveInstallSession } = await import("../../auth/github-install-store");
    const code = createInstallSession("ws-1");
    resolveInstallSession(code, {
      status: "error",
      errorCode: "github_installation_conflict",
      errorMessage: "disconnect first",
    });

    const { pollGET } = await import("../../routes/github-install");
    for (let poll = 0; poll < 2; poll += 1) {
      const response = await pollGET(bunRequest(code));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "error",
        errorCode: "github_installation_conflict",
        errorMessage: "disconnect first",
      });
    }
  });
});

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

function bunRequest(): Request {
  return new Request("http://internal.test/webhooks/github", { method: "POST" });
}

// See fireflies/route.test.ts's comment: mock.module() mutates shared
// exports in place, so capture the real bindings before mocking and restore
// them in afterAll to avoid leaking into other test files in the same run.
const realRequestAuthModule = await import("../../../webhooks/github/request-auth");
const realNormalizeModule = await import("../../../ingestion/github/normalize");
const realInstallationSyncModule = await import("../../../ingestion/github/installation-sync");
const RealGithubWebhookAuthError = realRequestAuthModule.GithubWebhookAuthError;
const realAuthenticateGithubWebhookRequest = realRequestAuthModule.authenticateGithubWebhookRequest;
const realIngestGithubPullRequestEvent = realNormalizeModule.ingestGithubPullRequestEvent;
const realIngestGithubPushEvent = realNormalizeModule.ingestGithubPushEvent;
const realHandleInstallationEvent = realInstallationSyncModule.handleInstallationEvent;
const realHandleInstallationRepositoriesEvent = realInstallationSyncModule.handleInstallationRepositoriesEvent;

function restoreRealModules() {
  mock.module("../../../webhooks/github/request-auth", () => ({
    GithubWebhookAuthError: RealGithubWebhookAuthError,
    authenticateGithubWebhookRequest: realAuthenticateGithubWebhookRequest,
  }));
  mock.module("../../../ingestion/github/normalize", () => ({
    ingestGithubPullRequestEvent: realIngestGithubPullRequestEvent,
    ingestGithubPushEvent: realIngestGithubPushEvent,
  }));
  mock.module("../../../ingestion/github/installation-sync", () => ({
    handleInstallationEvent: realHandleInstallationEvent,
    handleInstallationRepositoriesEvent: realHandleInstallationRepositoriesEvent,
  }));
}

describe("POST /webhooks/github", () => {
  // Named imports are live bindings -- restoring only in afterAll leaves a
  // window where a sibling test file (e.g. request-auth.test.ts) can run
  // and see this file's last mock.module() call instead of the real
  // implementation. Restore after every test to close that window.
  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("returns 401 with no body when authentication fails", async () => {
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => {
        throw new RealGithubWebhookAuthError("GitHub webhook signature is invalid");
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("returns 200 without dispatch for a ping event", async () => {
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({
        eventType: "ping",
        payload: {},
        connection: null,
      }),
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
  });

  it("no-ops with 200 when no connection resolves yet (callback/webhook race)", async () => {
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({
        eventType: "pull_request",
        payload: {},
        connection: null,
      }),
    }));
    let called = false;
    mock.module("../../../ingestion/github/normalize", () => ({
      ingestGithubPullRequestEvent: async () => {
        called = true;
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
    expect(called).toBe(false);
  });

  it("dispatches pull_request to ingestGithubPullRequestEvent", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const payload = { action: "opened" };
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({ eventType: "pull_request", payload, connection }),
    }));
    let called: unknown[] | undefined;
    mock.module("../../../ingestion/github/normalize", () => ({
      ingestGithubPullRequestEvent: async (...args: unknown[]) => {
        called = args;
      },
      ingestGithubPushEvent: async () => {
        throw new Error("should not be called");
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
    expect(called).toEqual([connection, payload]);
  });

  it("dispatches push to ingestGithubPushEvent", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const payload = { ref: "refs/heads/main" };
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({ eventType: "push", payload, connection }),
    }));
    let called: unknown[] | undefined;
    mock.module("../../../ingestion/github/normalize", () => ({
      ingestGithubPullRequestEvent: async () => {
        throw new Error("should not be called");
      },
      ingestGithubPushEvent: async (...args: unknown[]) => {
        called = args;
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
    expect(called).toEqual([connection, payload]);
  });

  it("dispatches installation to handleInstallationEvent", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const payload = { action: "deleted", installation: { id: 1 } };
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({ eventType: "installation", payload, connection }),
    }));
    let called: unknown[] | undefined;
    mock.module("../../../ingestion/github/installation-sync", () => ({
      handleInstallationEvent: async (...args: unknown[]) => {
        called = args;
      },
      handleInstallationRepositoriesEvent: async () => {
        throw new Error("should not be called");
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
    expect(called).toEqual([payload]);
  });

  it("returns 200 without dispatch for an unrecognized event", async () => {
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({
        eventType: "star",
        payload: {},
        connection: { id: "conn-1", workspace_id: "ws-1" },
      }),
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(200);
  });

  it("returns 500 with no leaked detail on an unexpected error", async () => {
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => {
        throw new Error("db connection refused at 10.0.0.5:5432 with credentials xyz");
      },
    }));

    const { POST } = await import("../../../webhooks/github/route");
    const response = await POST(bunRequest());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("db connection refused");
    expect(text).not.toContain("10.0.0.5");
  });
});

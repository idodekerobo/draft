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
const realEnqueueModule = await import("../../../events/enqueue-routine-events");
const realEnqueueRoutineEvents = realEnqueueModule.enqueueRoutineEvents;
const realFireEnqueueRoutineEvents = realEnqueueModule.fireEnqueueRoutineEvents;

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
  mock.module("../../../events/enqueue-routine-events", () => ({
    enqueueRoutineEvents: realEnqueueRoutineEvents,
    fireEnqueueRoutineEvents: realFireEnqueueRoutineEvents,
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
        return { skipped: true };
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
        return { skipped: true };
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

  it("starts the routines waiting for an opened or merged pull request, and not for an edit", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const fired: unknown[] = [];
    mock.module("../../../events/enqueue-routine-events", () => ({ fireEnqueueRoutineEvents: (input: unknown) => fired.push(input) }));
    mock.module("../../../ingestion/github/normalize", () => ({
      ingestGithubPullRequestEvent: async () => ({ sourceItemId: "item-1" }),
      ingestGithubPushEvent: async () => ({ sourceItemIds: [] }),
    }));
    const pr = (action: string, merged = false) => ({ action, pull_request: { number: 7, merged }, repository: { full_name: "acme/app" } });
    for (const payload of [pr("opened"), pr("edited"), pr("closed", true), pr("closed")]) {
      mock.module("../../../webhooks/github/request-auth", () => ({
        GithubWebhookAuthError: RealGithubWebhookAuthError,
        authenticateGithubWebhookRequest: async () => ({ eventType: "pull_request", payload, connection }),
      }));
      const { POST } = await import("../../../webhooks/github/route");
      expect((await POST(bunRequest())).status).toBe(200);
    }
    expect(fired).toEqual([
      { workspaceId: "ws-1", connectionId: "conn-1", name: "github.pull_request_opened", eventId: "acme/app#7", sourceItemId: "item-1", facts: expect.arrayContaining([{ label: "Pull request", value: "#7" }]), concurrencyKey: "github:acme/app#7" },
      { workspaceId: "ws-1", connectionId: "conn-1", name: "github.pull_request_merged", eventId: "acme/app#7", sourceItemId: "item-1", facts: expect.arrayContaining([{ label: "Repository", value: "acme/app" }]), concurrencyKey: "github:acme/app#7" },
    ]);
  });

  it("queues the push routine event keyed to its branch, and reads it from the newest commit", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const fired: unknown[] = [];
    mock.module("../../../events/enqueue-routine-events", () => ({ fireEnqueueRoutineEvents: (input: unknown) => fired.push(input) }));
    mock.module("../../../ingestion/github/normalize", () => ({
      ingestGithubPullRequestEvent: async () => ({ skipped: true }),
      ingestGithubPushEvent: async () => ({ sourceItemIds: ["item-a", "item-b"] }),
    }));
    const payload = {
      ref: "refs/heads/main",
      before: "0000",
      after: "c2",
      compare: "https://github.example.test/compare",
      repository: { full_name: "acme/app" },
      commits: [
        { id: "c1", message: "First", author: { name: "Uzo" } },
        { id: "c2", message: "Second", author: { name: "Uzo" } },
      ],
    };
    mock.module("../../../webhooks/github/request-auth", () => ({
      GithubWebhookAuthError: RealGithubWebhookAuthError,
      authenticateGithubWebhookRequest: async () => ({ eventType: "push", payload, connection }),
    }));

    const { POST } = await import("../../../webhooks/github/route");
    expect((await POST(bunRequest())).status).toBe(200);

    expect(fired).toEqual([
      {
        workspaceId: "ws-1",
        connectionId: "conn-1",
        name: "github.push",
        eventId: "acme/app@c2",
        sourceItemId: "item-b",
        facts: expect.arrayContaining([{ label: "Branch", value: "main" }]),
        concurrencyKey: "github:acme/app@main",
      },
    ]);
  });
});

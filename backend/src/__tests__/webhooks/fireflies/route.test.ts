import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

function bunRequest(connectionKey: string): Bun.BunRequest<"/webhooks/fireflies/:connectionKey"> {
  const request = new Request(`http://internal.test/webhooks/fireflies/${connectionKey}`, {
    method: "POST",
  });
  return Object.assign(request, { params: { connectionKey } }) as Bun.BunRequest<"/webhooks/fireflies/:connectionKey">;
}

// mock.module() mutates the module's exports object in place (the "real"
// module import below is a live binding to that same object), so mocking
// "../../../webhooks/fireflies/request-auth" here would otherwise leak into
// request-auth.test.ts when both files run in the same `bun test` process.
// Capture the real functions by value up front (before any mocking touches
// the shared exports object) and restore them in afterAll.
const realRequestAuthModule = await import("../../../webhooks/fireflies/request-auth");
const realNormalizeModule = await import("../../../ingestion/fireflies/normalize");
const RealFirefliesWebhookAuthError = realRequestAuthModule.FirefliesWebhookAuthError;
const realAuthenticateFirefliesWebhookRequest = realRequestAuthModule.authenticateFirefliesWebhookRequest;
const realIngestFirefliesMeeting = realNormalizeModule.ingestFirefliesMeeting;

describe("POST /webhooks/fireflies/:connectionKey", () => {
  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: realAuthenticateFirefliesWebhookRequest,
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: realIngestFirefliesMeeting,
    }));
  });

  it("returns 401 with no body when authentication fails", async () => {
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => {
        throw new RealFirefliesWebhookAuthError("Fireflies webhook signature is invalid");
      },
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => {
        throw new Error("should not be called");
      },
    }));

    const { POST } = await import("../../../webhooks/fireflies/route");
    const response = await POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toBe("");
  });

  it("calls ingestFirefliesMeeting and returns 200 for a handled event", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };

    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection,
        event: "meeting.summarized",
        meetingId: "meeting-123",
      }),
    }));

    let called: unknown[] | undefined;
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async (...args: unknown[]) => {
        called = args;
        return { sourceItemId: "item-1" };
      },
    }));

    const routeModule = await import("../../../webhooks/fireflies/route");
    const response = await routeModule.POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(200);
    expect(called).toEqual([connection, "meeting-123"]);
  });

  it("returns 200 without calling ingestFirefliesMeeting for an unrecognized event", async () => {
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        event: "meeting.deleted",
        meetingId: "meeting-123",
      }),
    }));

    let called = false;
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => {
        called = true;
        return { sourceItemId: "item-1" };
      },
    }));

    const routeModule = await import("../../../webhooks/fireflies/route");
    const response = await routeModule.POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(200);
    expect(called).toBe(false);
  });

  it("returns 500 with no leaked detail on an unexpected error", async () => {
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => {
        throw new Error("db connection refused at 10.0.0.5:5432 with credentials xyz");
      },
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => ({ sourceItemId: "item-1" }),
    }));

    const routeModule = await import("../../../webhooks/fireflies/route");
    const response = await routeModule.POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("db connection refused");
    expect(text).not.toContain("10.0.0.5");
  });
});

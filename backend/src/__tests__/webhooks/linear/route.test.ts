import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

function bunRequest(connectionKey: string): Bun.BunRequest<"/webhooks/linear/:connectionKey"> {
  const request = new Request(`http://internal.test/webhooks/linear/${connectionKey}`, {
    method: "POST",
  });
  return Object.assign(request, { params: { connectionKey } }) as Bun.BunRequest<"/webhooks/linear/:connectionKey">;
}

const realRequestAuthModule = await import("../../../webhooks/linear/request-auth");
const realNormalizeModule = await import("../../../ingestion/linear/normalize");
const RealLinearWebhookAuthError = realRequestAuthModule.LinearWebhookAuthError;
const realAuthenticateLinearWebhookRequest = realRequestAuthModule.authenticateLinearWebhookRequest;
const realIngestLinearEvent = realNormalizeModule.ingestLinearEvent;

function restoreRealModules() {
  mock.module("../../../webhooks/linear/request-auth", () => ({
    LinearWebhookAuthError: RealLinearWebhookAuthError,
    authenticateLinearWebhookRequest: realAuthenticateLinearWebhookRequest,
  }));
  mock.module("../../../ingestion/linear/normalize", () => ({
    ingestLinearEvent: realIngestLinearEvent,
  }));
}

describe("POST /webhooks/linear/:connectionKey", () => {
  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("returns 401 with no body and does not ingest when authentication fails", async () => {
    mock.module("../../../webhooks/linear/request-auth", () => ({
      LinearWebhookAuthError: RealLinearWebhookAuthError,
      authenticateLinearWebhookRequest: async () => {
        throw new RealLinearWebhookAuthError("Linear webhook signature is invalid");
      },
    }));
    let called = false;
    mock.module("../../../ingestion/linear/normalize", () => ({
      ingestLinearEvent: async () => {
        called = true;
      },
    }));

    const { POST } = await import("../../../webhooks/linear/route");
    const response = await POST(bunRequest("acme-linear"));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(called).toBe(false);
  });

  it("passes the authenticated connection and payload to ingestion", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const payload = {
      type: "Issue" as const,
      action: "update" as const,
      webhookTimestamp: Date.now(),
      data: { id: "issue-1", title: "Ship lifecycle guards" },
    };
    mock.module("../../../webhooks/linear/request-auth", () => ({
      LinearWebhookAuthError: RealLinearWebhookAuthError,
      authenticateLinearWebhookRequest: async () => ({ connection, payload }),
    }));
    let called: unknown[] | undefined;
    mock.module("../../../ingestion/linear/normalize", () => ({
      ingestLinearEvent: async (...args: unknown[]) => {
        called = args;
        return { sourceItemId: "item-1" };
      },
    }));

    const { POST } = await import("../../../webhooks/linear/route");
    const response = await POST(bunRequest("acme-linear"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(called).toEqual([connection, payload]);
  });

  it("returns 500 with no provider or credential detail on an unexpected error", async () => {
    const canary = "linear-api-token-canary";
    mock.module("../../../webhooks/linear/request-auth", () => ({
      LinearWebhookAuthError: RealLinearWebhookAuthError,
      authenticateLinearWebhookRequest: async () => {
        throw new Error(`provider rejected credential ${canary}`);
      },
    }));

    const { POST } = await import("../../../webhooks/linear/route");
    const response = await POST(bunRequest("acme-linear"));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("provider rejected");
    expect(text).not.toContain(canary);
  });
});

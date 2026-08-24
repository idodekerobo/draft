import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "draft-context-test";
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "test-private-key";
process.env.GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "webhook-secret";

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
const realDbClientModule = await import("../../../db/client");
const RealFirefliesWebhookAuthError = realRequestAuthModule.FirefliesWebhookAuthError;
const realAuthenticateFirefliesWebhookRequest = realRequestAuthModule.authenticateFirefliesWebhookRequest;
const realIngestFirefliesMeeting = realNormalizeModule.ingestFirefliesMeeting;
const realServiceClient = realDbClientModule.serviceClient;

function mockEvidenceClient(
  status: "active" | "degraded" | "revoked" = "active",
  rpcError: { message: string } | null = null,
) {
  const state: {
    lastSuccessAt: string | null;
    updateAttempts: number;
    currentCredentialId: string;
    rpcCalls: Array<{ functionName: string; params: Record<string, unknown> }>;
  } = {
    lastSuccessAt: null,
    updateAttempts: 0,
    currentCredentialId: "credential-1",
    rpcCalls: [],
  };
  mock.module("../../../db/client", () => ({
    serviceClient: {
      from(table: string) {
        if (table === "errors") return { insert: async () => ({ error: null }) };
        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, params: Record<string, unknown>) {
        state.rpcCalls.push({ functionName, params });
        state.updateAttempts += 1;
        if (rpcError) return { data: null, error: rpcError };
        const matchesGeneration = params.p_credential_id === state.currentCredentialId;
        const ingestible = status === "active" || status === "degraded";
        if (matchesGeneration && ingestible) {
          state.lastSuccessAt = String(params.p_succeeded_at);
        }
        return { data: matchesGeneration && ingestible, error: null };
      },
    },
  }));
  return state;
}

function restoreRealModules() {
  mock.module("../../../webhooks/fireflies/request-auth", () => ({
    FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
    authenticateFirefliesWebhookRequest: realAuthenticateFirefliesWebhookRequest,
  }));
  mock.module("../../../ingestion/fireflies/normalize", () => ({
    ingestFirefliesMeeting: realIngestFirefliesMeeting,
  }));
  mock.module("../../../db/client", () => ({ serviceClient: realServiceClient }));
}

describe("POST /webhooks/fireflies/:connectionKey", () => {
  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("returns 401 with no body when authentication fails", async () => {
    const evidence = mockEvidenceClient();
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
    expect(evidence.updateAttempts).toBe(0);
  });

  it("calls ingestFirefliesMeeting and returns 200 for a handled event", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const evidence = mockEvidenceClient("active");

    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection,
        credentialId: "credential-1",
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
    expect(evidence.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(evidence.rpcCalls[0]).toMatchObject({
      functionName: "mark_fireflies_webhook_success",
      params: {
        p_connection_id: "conn-1",
        p_workspace_id: "ws-1",
        p_credential_id: "credential-1",
      },
    });
  });

  it("advances readiness on an authenticated unrecognized-event no-op", async () => {
    const evidence = mockEvidenceClient("degraded");
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
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
    expect(evidence.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not advance readiness when ingestion fails", async () => {
    const evidence = mockEvidenceClient();
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        event: "meeting.transcribed",
        meetingId: "meeting-123",
      }),
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => { throw new Error("ingestion failed"); },
    }));

    const { POST } = await import("../../../webhooks/fireflies/route");
    const response = await POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(500);
    expect(evidence.updateAttempts).toBe(0);
    expect(evidence.lastSuccessAt).toBeNull();
  });

  it("keeps 200 but does not advance readiness if the connection became inactive", async () => {
    const evidence = mockEvidenceClient("revoked");
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        event: "meeting.summarized",
        meetingId: "meeting-123",
      }),
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => ({ sourceItemId: "item-1" }),
    }));

    const { POST } = await import("../../../webhooks/fireflies/route");
    const response = await POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(200);
    expect(evidence.updateAttempts).toBe(1);
    expect(evidence.lastSuccessAt).toBeNull();
  });

  it("does not advance readiness when credentials rotate after authentication", async () => {
    const evidence = mockEvidenceClient("active");
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        event: "meeting.summarized",
        meetingId: "meeting-123",
      }),
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => {
        evidence.currentCredentialId = "credential-2";
        return { sourceItemId: "item-1" };
      },
    }));

    const { POST } = await import("../../../webhooks/fireflies/route");
    const response = await POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(200);
    expect(evidence.updateAttempts).toBe(1);
    expect(evidence.lastSuccessAt).toBeNull();
    expect(evidence.rpcCalls[0]?.params.p_credential_id).toBe("credential-1");
  });

  it("returns 500 when the evidence update RPC fails", async () => {
    const evidence = mockEvidenceClient("active", { message: "database unavailable" });
    mock.module("../../../webhooks/fireflies/request-auth", () => ({
      FirefliesWebhookAuthError: RealFirefliesWebhookAuthError,
      authenticateFirefliesWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        event: "meeting.deleted",
        meetingId: "meeting-123",
      }),
    }));
    mock.module("../../../ingestion/fireflies/normalize", () => ({
      ingestFirefliesMeeting: async () => { throw new Error("should not be called"); },
    }));

    const { POST } = await import("../../../webhooks/fireflies/route");
    const response = await POST(bunRequest("acme-fireflies"));

    expect(response.status).toBe(500);
    expect(evidence.updateAttempts).toBe(1);
    expect(evidence.lastSuccessAt).toBeNull();
  });

  it("returns 500 with no leaked detail on an unexpected error", async () => {
    const evidence = mockEvidenceClient();
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
    expect(evidence.updateAttempts).toBe(0);
  });
});

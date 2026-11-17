import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "draft-context-test";
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "test-private-key";
process.env.GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "webhook-secret";

function bunRequest(connectionKey: string): Bun.BunRequest<"/webhooks/granola/:connectionKey"> {
  const request = new Request(`http://internal.test/webhooks/granola/${connectionKey}`, { method: "POST" });
  return Object.assign(request, { params: { connectionKey } }) as Bun.BunRequest<"/webhooks/granola/:connectionKey">;
}

// mock.module() mutates the module's exports object in place, so mocking
// these here would otherwise leak into request-auth.test.ts when both run
// in the same `bun test` process. Capture the real exports up front.
const realRequestAuthModule = await import("../../../webhooks/granola/request-auth");
const realNormalizeModule = await import("../../../ingestion/granola/normalize");
const realDbClientModule = await import("../../../db/client");
const RealGranolaWebhookAuthError = realRequestAuthModule.GranolaWebhookAuthError;
const realAuthenticateGranolaWebhookRequest = realRequestAuthModule.authenticateGranolaWebhookRequest;
const realIngestGranolaNote = realNormalizeModule.ingestGranolaNote;
const realServiceClient = realDbClientModule.serviceClient;
const realEnqueueModule = await import("../../../events/enqueue-routine-events");
const realEnqueueRoutineEvents = realEnqueueModule.enqueueRoutineEvents;
const realFireEnqueueRoutineEvents = realEnqueueModule.fireEnqueueRoutineEvents;

function mockEvidenceClient(
  status: "active" | "degraded" | "revoked" = "active",
  rpcError: { message: string } | null = null,
) {
  const state: {
    lastSuccessAt: string | null;
    updateAttempts: number;
    currentCredentialId: string;
    rpcCalls: Array<{ functionName: string; params: Record<string, unknown> }>;
  } = { lastSuccessAt: null, updateAttempts: 0, currentCredentialId: "credential-1", rpcCalls: [] };
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
        if (matchesGeneration && ingestible) state.lastSuccessAt = String(params.p_succeeded_at);
        return { data: matchesGeneration && ingestible, error: null };
      },
    },
  }));
  return state;
}

function restoreRealModules() {
  mock.module("../../../webhooks/granola/request-auth", () => ({
    GranolaWebhookAuthError: RealGranolaWebhookAuthError,
    authenticateGranolaWebhookRequest: realAuthenticateGranolaWebhookRequest,
  }));
  mock.module("../../../ingestion/granola/normalize", () => ({
    ingestGranolaNote: realIngestGranolaNote,
  }));
  mock.module("../../../db/client", () => ({ serviceClient: realServiceClient }));
  mock.module("../../../events/enqueue-routine-events", () => ({
    enqueueRoutineEvents: realEnqueueRoutineEvents,
    fireEnqueueRoutineEvents: realFireEnqueueRoutineEvents,
  }));
}

describe("POST /webhooks/granola/:connectionKey", () => {
  afterEach(() => {
    mock.restore();
    restoreRealModules();
  });

  afterAll(restoreRealModules);

  it("returns 401 with no body when authentication fails", async () => {
    const evidence = mockEvidenceClient();
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => {
        throw new RealGranolaWebhookAuthError("Granola webhook signature is invalid");
      },
    }));
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async () => { throw new Error("should not be called"); },
    }));

    const { POST } = await import("../../../webhooks/granola/route");
    const response = await POST(bunRequest("acme-granola"));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(evidence.updateAttempts).toBe(0);
  });

  it("calls ingestGranolaNote and returns 200 for a handled event", async () => {
    const connection = { id: "conn-1", workspace_id: "ws-1" };
    const evidence = mockEvidenceClient("active");

    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => ({
        connection,
        credentialId: "credential-1",
        eventId: "evt-1",
        eventType: "note.generated",
        noteId: "not_123",
      }),
    }));

    let called: unknown[] | undefined;
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async (...args: unknown[]) => {
        called = args;
        return { sourceItemId: "item-1" };
      },
    }));

    const routeModule = await import("../../../webhooks/granola/route");
    const response = await routeModule.POST(bunRequest("acme-granola"));

    expect(response.status).toBe(200);
    expect(called).toEqual([connection, "credential-1", "not_123"]);
    expect(evidence.rpcCalls[0]).toMatchObject({
      functionName: "mark_granola_webhook_success",
      params: { p_connection_id: "conn-1", p_workspace_id: "ws-1", p_credential_id: "credential-1" },
    });
  });

  it("queues the routine events for a generated note, keyed to the note", async () => {
    mockEvidenceClient("active");
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        eventId: "evt-1",
        eventType: "note.generated",
        noteId: "not_123",
      }),
    }));
    mock.module("../../../ingestion/granola/normalize", () => ({ ingestGranolaNote: async () => ({ sourceItemId: "item-1" }) }));
    const fired: unknown[] = [];
    mock.module("../../../events/enqueue-routine-events", () => ({ fireEnqueueRoutineEvents: (input: unknown) => fired.push(input) }));

    const { POST } = await import("../../../webhooks/granola/route");
    expect((await POST(bunRequest("acme-granola"))).status).toBe(200);

    expect(fired).toEqual([
      {
        workspaceId: "ws-1",
        sourceConnectionId: "conn-1",
        name: "granola.note_ready",
        eventId: "not_123",
        sourceItemId: "item-1",
        facts: [{ label: "Granola note id", value: "not_123" }],
        concurrencyKey: "granola:not_123",
      },
    ]);
  });

  it("ingests on note.access_granted just like note.generated", async () => {
    const evidence = mockEvidenceClient("active");
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        eventId: "evt-1",
        eventType: "note.access_granted",
        noteId: "not_123",
      }),
    }));
    let called = false;
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async () => { called = true; return { sourceItemId: "item-1" }; },
    }));

    const { POST } = await import("../../../webhooks/granola/route");
    const response = await POST(bunRequest("acme-granola"));

    expect(response.status).toBe(200);
    expect(called).toBe(true);
    expect(evidence.updateAttempts).toBe(1);
  });

  it("advances readiness on an authenticated unrecognized-event no-op", async () => {
    const evidence = mockEvidenceClient("degraded");
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        eventId: "evt-1",
        eventType: "note.some_future_event",
        noteId: "not_123",
      }),
    }));
    let called = false;
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async () => { called = true; return { sourceItemId: "item-1" }; },
    }));

    const routeModule = await import("../../../webhooks/granola/route");
    const response = await routeModule.POST(bunRequest("acme-granola"));

    expect(response.status).toBe(200);
    expect(called).toBe(false);
    expect(evidence.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not advance readiness when ingestion fails", async () => {
    const evidence = mockEvidenceClient();
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => ({
        connection: { id: "conn-1", workspace_id: "ws-1" },
        credentialId: "credential-1",
        eventId: "evt-1",
        eventType: "note.edited",
        noteId: "not_123",
      }),
    }));
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async () => { throw new Error("ingestion failed"); },
    }));

    const { POST } = await import("../../../webhooks/granola/route");
    const response = await POST(bunRequest("acme-granola"));

    expect(response.status).toBe(500);
    expect(evidence.updateAttempts).toBe(0);
  });

  it("returns 500 with no leaked detail on an unexpected error", async () => {
    const evidence = mockEvidenceClient();
    mock.module("../../../webhooks/granola/request-auth", () => ({
      GranolaWebhookAuthError: RealGranolaWebhookAuthError,
      authenticateGranolaWebhookRequest: async () => {
        throw new Error("db connection refused at 10.0.0.5:5432 with credentials xyz");
      },
    }));
    mock.module("../../../ingestion/granola/normalize", () => ({
      ingestGranolaNote: async () => ({ sourceItemId: "item-1" }),
    }));

    const routeModule = await import("../../../webhooks/granola/route");
    const response = await routeModule.POST(bunRequest("acme-granola"));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("db connection refused");
    expect(text).not.toContain("10.0.0.5");
    expect(evidence.updateAttempts).toBe(0);
  });
});

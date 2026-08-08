import { beforeEach, describe, expect, it, mock } from "bun:test";
import { decryptCredentialPayload } from "../../credentials/crypto";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface Connection {
  id: string;
  provider: "slack" | "fireflies";
  credential_id: string | null;
  connection_key: string;
  status: string;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  config_json: Record<string, unknown>;
  workspace_id: string;
}

interface Credential {
  id: string;
  workspace_id: string;
  provider: string;
  encrypted_payload: string;
  encryption_key_version: string;
  status: string;
}

interface ScheduledTask {
  workspace_id: string;
  task_type: string;
  task_key: string;
  enabled: boolean;
}

const state: {
  connections: Connection[];
  credentials: Credential[];
  scheduledTasks: ScheduledTask[];
} = { connections: [], credentials: [], scheduledTasks: [] };

function matches(row: object, filters: Record<string, unknown>): boolean {
  const values = row as Record<string, unknown>;
  return Object.entries(filters).every(([key, value]) => values[key] === value);
}

function createFakeClient() {
  return {
    from(table: string) {
      let operation: "select" | "update" | "insert" | "upsert" = "select";
      let payload: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      let selected = "";
      let hasInFilter = false;

      const execute = async () => {
        if (table === "source_connections") {
          if (operation === "select") {
            if (hasInFilter) return { data: state.connections.map((row) => ({ ...row })), error: null };
            const row = state.connections.find((candidate) => matches(candidate, filters));
            return { data: row ? { ...row } : null, error: null };
          }
          if (operation === "update") {
            const rows = state.connections.filter((candidate) => matches(candidate, filters));
            for (const row of rows) Object.assign(row, payload);
            if (selected) return { data: rows.map((row) => ({ id: row.id })), error: null };
            return { data: null, error: null };
          }
          if (operation === "insert") {
            const row = {
              ...(payload as unknown as Connection),
              id: "connection-new",
              status: "active",
              display_name: null,
              last_success_at: null,
              last_error_at: null,
              config_json: payload.config_json ?? {},
              workspace_id: payload.workspace_id,
            } as Connection;
            state.connections.push(row);
            return { data: { id: row.id }, error: null };
          }
        }

        if (table === "credentials") {
          if (operation === "update") {
            const rows = state.credentials.filter((candidate) => matches(candidate, filters));
            for (const row of rows) Object.assign(row, payload);
            return { data: rows.map((row) => ({ id: row.id })), error: null };
          }
          if (operation === "insert") {
            const row = { ...(payload as unknown as Credential), id: "credential-new" } as Credential;
            state.credentials.push(row);
            return { data: { id: row.id }, error: null };
          }
        }

        if (table === "scheduled_tasks") {
          if (operation === "update") {
            const rows = state.scheduledTasks.filter((candidate) => matches(candidate, filters));
            for (const row of rows) Object.assign(row, payload);
            return { data: null, error: null };
          }
          if (operation === "upsert") {
            state.scheduledTasks.push(payload as unknown as ScheduledTask);
            return { data: null, error: null };
          }
        }

        throw new Error(`Unexpected fake query: ${operation} ${table}`);
      };

      const builder: Record<string, any> = {
        select(columns: string) {
          selected = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        in() {
          hasInFilter = true;
          return builder;
        },
        update(nextPayload: Record<string, unknown>) {
          operation = "update";
          payload = nextPayload;
          return builder;
        },
        insert(nextPayload: Record<string, unknown>) {
          operation = "insert";
          payload = nextPayload;
          return builder;
        },
        upsert(nextPayload: Record<string, unknown>) {
          operation = "upsert";
          payload = nextPayload;
          return builder;
        },
        async maybeSingle() {
          const result = await execute();
          if (Array.isArray(result.data)) return { data: result.data[0] ?? null, error: result.error };
          return result;
        },
        async single() {
          const result = await execute();
          if (Array.isArray(result.data)) return { data: result.data[0] ?? null, error: result.error };
          return result;
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return execute().then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

process.env.SUPABASE_URL = "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
process.env.SUPABASE_SECRET_KEY = "service-key";
process.env.API_BASE_URL = "https://api.example.test";
process.env.INFERENCE_CREDENTIAL_KEK_V1 = Buffer.alloc(32, 7).toString("base64");

let accessResult: Response | null = null;
const fakeClient = createFakeClient();
let restartedSlackListeners: string[] = [];
let stoppedSlackListeners: string[] = [];
let slackJoinCalls: string[] = [];
let slackJoinError: string | null = null;

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({ serviceClient: fakeClient }));
mock.module("../../credentials/resolve-provider-credential", () => ({
  resolveProviderCredential: async () => ({ bot_token: "xoxb-stored", app_token: "xapp-stored" }),
}));
mock.module("../../ingestion/slack/bootstrap", () => ({
  restartSlackListener: async (connectionId: string) => { restartedSlackListeners.push(connectionId); },
  stopSlackListener: (connectionId: string) => { stoppedSlackListeners.push(connectionId); },
}));

const routeModule = await import("../../routes/connections");

beforeEach(() => {
  accessResult = null;
  restartedSlackListeners = [];
  stoppedSlackListeners = [];
  slackJoinCalls = [];
  slackJoinError = null;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/conversations.list")) {
      return Response.json({
        ok: true,
        channels: [
          { id: "C-old", name: "product-planning", num_members: 8, is_member: true },
          { id: "C-other", name: "announcements", num_members: 20, is_member: false },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url === "https://slack.com/api/conversations.join") {
      const body = init?.body as URLSearchParams;
      slackJoinCalls.push(body.get("channel") ?? "");
      return Response.json(slackJoinError ? { ok: false, error: slackJoinError } : { ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  state.connections = [
    {
      id: "slack-connection",
      provider: "slack",
      credential_id: "slack-credential",
      connection_key: "slack-key",
      status: "active",
      display_name: "Slack",
      last_success_at: null,
      last_error_at: null,
      config_json: { channel_ids: ["C-old"] },
      workspace_id: workspaceId,
    },
  ];
  state.credentials = [
    {
      id: "slack-credential",
      workspace_id: workspaceId,
      provider: "slack",
      encrypted_payload: "old",
      encryption_key_version: "v1",
      status: "active",
    },
  ];
  state.scheduledTasks = [
    { workspace_id: workspaceId, task_type: "ingest_source", task_key: "slack-connection", enabled: true },
  ];
});

function request(method: string, params: Record<string, string>, body?: unknown): Request {
  return Object.assign(
    new Request("https://internal.test", {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params },
  );
}

describe("workspace connection routes", () => {
  it("fresh-connects Slack with an encrypted credential and scheduled task", async () => {
    state.connections = [];
    state.credentials = [];
    state.scheduledTasks = [];

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "slack",
        bot_token: "xoxb-bot-token",
        app_token: "xapp-app-token",
        channel_ids: ["C-one", "C-two"],
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.connection_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-one", "C-two"] });
    expect(slackJoinCalls).toEqual(["C-one", "C-two"]);
    expect(restartedSlackListeners).toEqual(["connection-new"]);
    expect(state.scheduledTasks).toHaveLength(1);
    const credential = state.credentials[0];
    expect(credential?.encryption_key_version).toBe("v1");
    expect(JSON.parse(decryptCredentialPayload(credential?.encrypted_payload, "v1"))).toEqual({
      bot_token: "xoxb-bot-token",
      app_token: "xapp-app-token",
    });
  });

  it("fresh-connects Fireflies with a generated webhook secret", async () => {
    state.connections = [];
    state.credentials = [];
    state.scheduledTasks = [];

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "fireflies", api_token: "fireflies-api-token" }) as never,
    );
    const body = await response.json() as { ok: boolean; webhookUrl: string; webhookSecret: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.webhookUrl).toMatch(/^https:\/\/api\.example\.test\/webhooks\/fireflies\//);
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhookSecret).not.toBe("fireflies-api-token");
    expect(state.connections[0]?.connection_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.scheduledTasks).toHaveLength(1);
    const credential = state.credentials[0];
    expect(JSON.parse(decryptCredentialPayload(credential?.encrypted_payload, "v1"))).toEqual({
      api_token: "fireflies-api-token",
      webhook_secret: body.webhookSecret,
    });
  });

  it("reconnects in place and reactivates the existing connection", async () => {
    const originalConnectionId = state.connections[0]?.id;
    const originalCredentialId = state.credentials[0]?.id;

    state.connections[0]!.status = "error";
    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "slack",
        bot_token: "xoxb-new-token",
        app_token: "xapp-new-token",
        channel_ids: ["C-new"],
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.id).toBe(originalConnectionId);
    expect(state.connections[0]?.credential_id).toBe(originalCredentialId);
    expect(state.connections[0]?.status).toBe("active");
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new"] });
    expect(slackJoinCalls).toEqual(["C-new"]);
    expect(restartedSlackListeners).toEqual(["slack-connection"]);
    expect(JSON.parse(decryptCredentialPayload(state.credentials[0]?.encrypted_payload, "v1"))).toEqual({
      bot_token: "xoxb-new-token",
      app_token: "xapp-new-token",
    });
  });

  it("returns the workspace access denial before writing credentials", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const beforeConnections = state.connections.length;
    const beforeCredentials = state.credentials.length;

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "fireflies",
        api_token: "should-not-write",
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(state.connections).toHaveLength(beforeConnections);
    expect(state.credentials).toHaveLength(beforeCredentials);
  });

  it("returns configured Slack channel IDs without exposing secrets", async () => {
    const response = await routeModule.GET(request("GET", { id: workspaceId }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connections: [{
        provider: "slack",
        status: "active",
        display_name: "Slack",
        last_success_at: null,
        last_error_at: null,
        channel_ids: ["C-old"],
      }],
    });
  });

  it("returns live Slack channel titles and marks configured channels", async () => {
    const response = await routeModule.CHANNELS_GET(
      request("GET", { id: workspaceId, provider: "slack" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channels: [
        { id: "C-other", name: "announcements", memberCount: 20, isMember: false, allowlisted: false },
        { id: "C-old", name: "product-planning", memberCount: 8, isMember: true, allowlisted: true },
      ],
    });
  });

  it("updates Slack channels in place", async () => {
    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, { channel_ids: ["C-new"] }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new"] });
    expect(slackJoinCalls).toEqual(["C-new"]);
  });

  it("does not store a Slack connection when joining a selected channel fails", async () => {
    state.connections = [];
    state.credentials = [];
    slackJoinError = "missing_scope";

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "slack",
        bot_token: "xoxb-bot-token",
        app_token: "xapp-app-token",
        channel_ids: ["C-one"],
      }) as never,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "slack_channel_join_failed:missing_scope" });
    expect(state.connections).toHaveLength(0);
    expect(state.credentials).toHaveLength(0);
  });

  it("rejects non-Slack channel updates", async () => {
    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "fireflies" }, { channel_ids: ["C-new"] }) as never,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_provider" });
  });

  it("revokes a connection and disables its matching ingest task", async () => {
    const response = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "slack" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.connections[0]?.status).toBe("revoked");
    expect(state.scheduledTasks[0]?.enabled).toBe(false);
    expect(stoppedSlackListeners).toEqual(["slack-connection"]);

    const secondResponse = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "slack" }) as never,
    );
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({ ok: true });
  });
});

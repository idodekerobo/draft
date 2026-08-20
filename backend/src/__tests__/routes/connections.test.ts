import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { decryptCredentialPayload, encryptCredentialPayload } from "../../credentials/crypto";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface Connection {
  id: string;
  provider: "slack" | "fireflies" | "linear" | "claude_session";
  credential_id: string | null;
  connection_key: string;
  status: string;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  config_json: Record<string, unknown>;
  workspace_id: string;
  updated_at?: string;
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
  source_connection_id?: string;
  task_type: string;
  task_key: string;
  enabled: boolean;
}

interface Workspace {
  id: string;
  inference_credential_id: string | null;
}

interface OperatorError {
  workspace_id: string;
  message: string;
  detail_json: Record<string, unknown>;
}

const state: {
  connections: Connection[];
  credentials: Credential[];
  scheduledTasks: ScheduledTask[];
  workspaces: Workspace[];
  errors: OperatorError[];
} = { connections: [], credentials: [], scheduledTasks: [], workspaces: [], errors: [] };

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
      const inFilters: Record<string, unknown[]> = {};
      let selected = "";
      let returnSingle = false;

      const rowMatches = (row: object) => matches(row, filters) && Object.entries(inFilters)
        .every(([key, values]) => values.includes((row as Record<string, unknown>)[key]));

      const execute = async () => {
        if (table === "source_connections") {
          if (operation === "select") {
            const rows = state.connections.filter(rowMatches).map((row) => ({ ...row }));
            return { data: returnSingle ? rows[0] ?? null : rows, error: null };
          }
          if (operation === "update") {
            const beforeUpdate = sourceConnectionBeforeUpdate;
            sourceConnectionBeforeUpdate = null;
            await beforeUpdate?.({ payload, filters: { ...filters }, inFilters: { ...inFilters } });
            if (sourceConnectionUpdateError) {
              const error = sourceConnectionUpdateError;
              sourceConnectionUpdateError = null;
              return { data: null, error };
            }
            const rows = state.connections.filter(rowMatches);
            for (const row of rows) {
              Object.assign(row, payload);
              row.updated_at = `2026-08-20T21:00:${String(sourceConnectionUpdateCount++).padStart(2, "0")}.000000+00:00`;
            }
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
          if (operation === "upsert") {
            const existing = state.connections.find((c) =>
              c.workspace_id === payload.workspace_id && c.provider === payload.provider && c.connection_key === payload.connection_key,
            );
            if (existing) {
              // Mirrors PostgREST merge-duplicates upsert: only keys present in
              // the payload get written -- an omitted `status` leaves the
              // existing row's status untouched.
              Object.assign(existing, payload);
              return { data: existing, error: null };
            }
            const row = {
              ...(payload as unknown as Connection),
              id: "connection-new",
              status: (payload.status as string | undefined) ?? "pending",
              display_name: (payload.display_name as string | null | undefined) ?? null,
              last_success_at: null,
              last_error_at: null,
              config_json: (payload.config_json as Record<string, unknown> | undefined) ?? {},
            } as Connection;
            state.connections.push(row);
            return { data: row, error: null };
          }
        }

        if (table === "credentials") {
          if (operation === "select") {
            const rows = state.credentials.filter(rowMatches).map((row) => ({ ...row }));
            return { data: returnSingle ? rows[0] ?? null : rows, error: null };
          }
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

        if (table === "workspaces") {
          if (operation === "select") {
            const rows = state.workspaces.filter(rowMatches).map((row) => ({ ...row }));
            return { data: returnSingle ? rows[0] ?? null : rows, error: null };
          }
          if (operation === "update") {
            const rows = state.workspaces.filter((candidate) => matches(candidate, filters));
            for (const row of rows) Object.assign(row, payload);
            return { data: null, error: null };
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

        if (table === "errors" && operation === "insert") {
          if (errorsInsertError) return { data: null, error: errorsInsertError };
          state.errors.push(payload as unknown as OperatorError);
          return { data: null, error: null };
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
        in(column: string, values: unknown[]) {
          inFilters[column] = values;
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
          returnSingle = true;
          const result = await execute();
          if (Array.isArray(result.data)) return { data: result.data[0] ?? null, error: result.error };
          return result;
        },
        async single() {
          returnSingle = true;
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
    async rpc(functionName: string, params: Record<string, unknown>) {
      if (functionName === "disconnect_source_connection") {
        if (disconnectRpcError) return { data: null, error: disconnectRpcError };
        const connection = state.connections.find((candidate) =>
          candidate.workspace_id === params.p_workspace_id &&
          candidate.provider === params.p_provider &&
          candidate.status !== "revoked"
        );
        if (!connection) {
          return { data: [{ connection_id: null, transitioned: false }], error: null };
        }
        connection.status = "revoked";
        for (const task of state.scheduledTasks) {
          if (task.workspace_id === connection.workspace_id &&
              (task.source_connection_id === connection.id || task.task_key === connection.id)) {
            task.enabled = false;
          }
        }
        return {
          data: [{ connection_id: connection.id, transitioned: true }],
          error: null,
        };
      }

      if (functionName === "commit_linear_connection_swap") {
        linearLifecycleEvents.push("commit");
        if (linearCommitError) return { data: null, error: linearCommitError };
        let connection = state.connections.find((candidate) =>
          candidate.workspace_id === params.p_workspace_id && candidate.provider === "linear"
        );
        if (connection) {
          if (params.p_expected_updated_at !== connection.updated_at) {
            return { data: null, error: { code: "P0001", message: "linear_connection_conflict" } };
          }
        } else if (params.p_expected_updated_at !== null) {
          return { data: null, error: { code: "P0001", message: "linear_connection_conflict" } };
        }

        const priorWebhookId = typeof connection?.config_json.linear_webhook_id === "string"
          ? connection.config_json.linear_webhook_id
          : null;
        const pendingWebhookIds = [
          ...(Array.isArray(connection?.config_json.linear_cleanup_pending_webhook_ids)
            ? connection.config_json.linear_cleanup_pending_webhook_ids.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            )
            : []),
          ...(priorWebhookId ? [priorWebhookId] : []),
        ].filter((value, index, values) =>
          value !== params.p_linear_webhook_id && values.indexOf(value) === index
        );
        let credential = connection?.credential_id
          ? state.credentials.find((candidate) => candidate.id === connection?.credential_id)
          : undefined;
        if (!credential) {
          credential = {
            id: `linear-credential-${state.credentials.length + 1}`,
            workspace_id: String(params.p_workspace_id),
            provider: "linear",
            encrypted_payload: String(params.p_encrypted_payload),
            encryption_key_version: String(params.p_encryption_key_version),
            status: "active",
          };
          state.credentials.push(credential);
        } else {
          credential.encrypted_payload = String(params.p_encrypted_payload);
          credential.encryption_key_version = String(params.p_encryption_key_version);
          credential.status = "active";
        }

        const updatedAt = `2026-08-20T20:00:0${linearCommitCount++}.000000+00:00`;
        if (!connection) {
          connection = {
            id: "linear-connection-new",
            provider: "linear",
            credential_id: credential.id,
            connection_key: String(params.p_connection_key),
            status: "active",
            display_name: null,
            last_success_at: null,
            last_error_at: null,
            config_json: { linear_webhook_id: params.p_linear_webhook_id },
            workspace_id: String(params.p_workspace_id),
            updated_at: updatedAt,
          };
          state.connections.push(connection);
        } else {
          connection.credential_id = credential.id;
          connection.connection_key = String(params.p_connection_key);
          connection.status = "active";
          connection.last_error_at = null;
          connection.config_json = {
            ...connection.config_json,
            linear_webhook_id: params.p_linear_webhook_id,
          };
          delete connection.config_json.linear_cleanup_pending_webhook_ids;
          if (pendingWebhookIds.length > 0) {
            connection.config_json.linear_cleanup_pending_webhook_ids = pendingWebhookIds;
          }
          connection.updated_at = updatedAt;
        }
        return {
          data: {
            connection_id: connection.id,
            credential_id: credential.id,
            prior_webhook_id: priorWebhookId,
            updated_at: updatedAt,
          },
          error: null,
        };
      }

      throw new Error(`Unexpected fake RPC: ${functionName}`);
    },
  };
}

process.env.SUPABASE_URL = "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key";
process.env.SUPABASE_SECRET_KEY = "service-key";
process.env.DRAFT_API_BASE_URL = "https://api.example.test";
process.env.INFERENCE_CREDENTIAL_KEK_V1 = Buffer.alloc(32, 7).toString("base64");
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_SLUG = "draft-context-test";
process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----";
process.env.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";

const realResolveProviderCredential = (
  await import("../../credentials/resolve-provider-credential")
).resolveProviderCredential;

let accessResult: Response | null = null;
const fakeClient = createFakeClient();
let restartedSlackListeners: string[] = [];
let stoppedSlackListeners: string[] = [];
let slackJoinCalls: string[] = [];
let slackLeaveCalls: string[] = [];
let slackJoinError: string | null = null;
let slackMembershipFailures = new Set<string>();
let slackProviderMembership = new Set<string>();
let sourceConnectionBeforeUpdate: ((input: {
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
  inFilters: Record<string, unknown[]>;
}) => void | Promise<void>) | null = null;
let sourceConnectionUpdateError: { message: string } | null = null;
let sourceConnectionUpdateCount = 0;
let errorsInsertError: { message: string } | null = null;
let disconnectRpcError: { message: string } | null = null;
let linearCommitError: { code?: string; message: string } | null = null;
let linearCommitCount = 0;
let linearWebhookIds: string[] = [];
let linearLifecycleEvents: string[] = [];
let linearWebhookRequests: Array<{
  authorization: string | null;
  body: { query: string; variables: Record<string, unknown> };
}> = [];
let linearWebhookDeleteRequests: Array<{ authorization: string | null; id: string }> = [];
let linearWebhookDeleteFailures = new Set<string>();
let linearWebhookDeleteRawDetail: string | null = null;
let linearWebhookFailureBody: string | null = null;

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

afterAll(() => {
  mock.module("../../credentials/resolve-provider-credential", () => ({
    resolveProviderCredential: realResolveProviderCredential,
  }));
});

beforeEach(() => {
  accessResult = null;
  restartedSlackListeners = [];
  stoppedSlackListeners = [];
  slackJoinCalls = [];
  slackLeaveCalls = [];
  slackJoinError = null;
  slackMembershipFailures = new Set();
  slackProviderMembership = new Set(["C-old"]);
  sourceConnectionBeforeUpdate = null;
  sourceConnectionUpdateError = null;
  sourceConnectionUpdateCount = 0;
  errorsInsertError = null;
  disconnectRpcError = null;
  linearCommitError = null;
  linearCommitCount = 0;
  linearWebhookIds = [];
  linearLifecycleEvents = [];
  linearWebhookRequests = [];
  linearWebhookDeleteRequests = [];
  linearWebhookDeleteFailures = new Set();
  linearWebhookDeleteRawDetail = null;
  linearWebhookFailureBody = null;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.linear.app/graphql") {
      const authorization = new Headers(init?.headers).get("authorization");
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("webhookDelete")) {
        const id = String(body.variables.id);
        linearLifecycleEvents.push(`delete:${id}`);
        linearWebhookDeleteRequests.push({ authorization, id });
        if (linearWebhookDeleteFailures.has(id)) {
          return Response.json({
            data: {
              webhookDelete: {
                success: false,
                raw_detail: linearWebhookDeleteRawDetail,
              },
            },
          });
        }
        return Response.json({ data: { webhookDelete: { success: true } } });
      }
      linearWebhookRequests.push({ authorization, body });
      if (linearWebhookFailureBody !== null) {
        return new Response(linearWebhookFailureBody, { status: 502 });
      }
      const webhookId = linearWebhookIds.shift() ?? "linear-webhook-new";
      linearLifecycleEvents.push(`create:${webhookId}`);
      return Response.json({
        data: {
          webhookCreate: {
            success: true,
            webhook: { id: webhookId, enabled: true },
          },
        },
      });
    }
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
    if (url === "https://slack.com/api/conversations.join" ||
        url === "https://slack.com/api/conversations.leave") {
      const body = init?.body as URLSearchParams;
      const channelId = body.get("channel") ?? "";
      const operation = url.endsWith(".join") ? "join" : "leave";
      if (operation === "join") slackJoinCalls.push(channelId);
      else slackLeaveCalls.push(channelId);
      const failed = slackMembershipFailures.has(`${operation}:${channelId}`) ||
        (operation === "join" && slackJoinError !== null);
      if (failed) return Response.json({ ok: false, error: slackJoinError ?? "provider_failure" });
      if (operation === "join") {
        if (slackProviderMembership.has(channelId)) {
          return Response.json({ ok: false, error: "already_in_channel" });
        }
        slackProviderMembership.add(channelId);
      } else {
        if (!slackProviderMembership.has(channelId)) {
          return Response.json({ ok: false, error: "not_in_channel" });
        }
        slackProviderMembership.delete(channelId);
      }
      return Response.json({ ok: true });
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
      updated_at: "2026-08-20T18:00:00.000000+00:00",
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
    {
      workspace_id: workspaceId,
      source_connection_id: "slack-connection",
      task_type: "ingest_source",
      task_key: "slack-connection",
      enabled: true,
    },
  ];
  state.workspaces = [
    { id: workspaceId, inference_credential_id: null },
  ];
  state.errors = [];
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

function seedLinearConnection(config: Record<string, unknown> = { linear_webhook_id: "linear-webhook-old" }) {
  const updatedAt = "2026-08-20T19:00:00.123456+00:00";
  state.connections = [{
    id: "linear-connection",
    provider: "linear",
    credential_id: "linear-credential",
    connection_key: "linear-key",
    status: "active",
    display_name: "Linear",
    last_success_at: null,
    last_error_at: null,
    config_json: config,
    workspace_id: workspaceId,
    updated_at: updatedAt,
  }];
  state.credentials = [{
    id: "linear-credential",
    workspace_id: workspaceId,
    provider: "linear",
    encrypted_payload: encryptCredentialPayload(
      JSON.stringify({ api_token: "linear-api-token-old", webhook_secret: "old-secret" }),
      "v1",
    ),
    encryption_key_version: "v1",
    status: "active",
  }];
  return updatedAt;
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

  it("connects Slack with an empty initial membership selection", async () => {
    state.connections = [];
    state.credentials = [];
    state.scheduledTasks = [];

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "slack",
        bot_token: "xoxb-bot-token",
        app_token: "xapp-app-token",
        channel_ids: [],
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: [] });
    expect(slackJoinCalls).toEqual([]);
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

  it("fresh-connects Linear after provider webhook creation succeeds", async () => {
    state.connections = [];
    state.credentials = [];

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token",
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(linearWebhookRequests).toHaveLength(1);
    expect(linearWebhookRequests[0]?.authorization).toBe("linear-api-token");
    const variables = linearWebhookRequests[0]?.body.variables as {
      url: string;
      secret: string;
    };
    expect(variables.url).toMatch(/^https:\/\/api\.example\.test\/webhooks\/linear\/[0-9a-f-]{36}$/);
    expect(variables.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.provider).toBe("linear");
    expect(state.connections[0]?.config_json).toEqual({ linear_webhook_id: "linear-webhook-new" });
    const credential = state.credentials[0];
    expect(JSON.parse(decryptCredentialPayload(credential?.encrypted_payload, "v1"))).toEqual({
      api_token: "linear-api-token",
      webhook_secret: variables.secret,
    });
  });

  it("returns a safe Linear create failure without raw response or signing secret", async () => {
    state.connections = [];
    state.credentials = [];
    const rawProviderBody = "canary-linear-provider-body";
    linearWebhookFailureBody = rawProviderBody;

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token",
      }) as never,
    );
    const responseText = await response.text();
    const signingSecret = linearWebhookRequests[0]?.body.variables.secret as string;

    expect(response.status).toBe(502);
    expect(JSON.parse(responseText)).toEqual({ error: "linear_webhook_create_failed" });
    expect(responseText).not.toContain(rawProviderBody);
    expect(responseText).not.toContain("linear-api-token");
    expect(responseText).not.toContain(signingSecret);
    expect(state.connections).toHaveLength(0);
    expect(state.credentials).toHaveLength(0);
  });

  it.each([
    [{ code: "P0001", message: "linear_connection_conflict" }, 409, "linear_connection_conflict"],
    [{ message: "database unavailable" }, 500, "linear_connection_commit_failed"],
  ] as const)(
    "deletes the new Linear webhook when the local commit fails",
    async (commitError, expectedStatus, expectedCode) => {
      state.connections = [];
      state.credentials = [];
      linearCommitError = { ...commitError };

      const response = await routeModule.POST(
        request("POST", { id: workspaceId }, {
          provider: "linear",
          api_token: "linear-api-token-new",
        }) as never,
      );

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: expectedCode });
      expect(linearWebhookDeleteRequests).toEqual([
        { authorization: "linear-api-token-new", id: "linear-webhook-new" },
      ]);
      expect(state.connections).toHaveLength(0);
      expect(state.credentials).toHaveLength(0);
    },
  );

  it("atomically replaces a Linear connection before deleting its old webhook", async () => {
    const expectedUpdatedAt = seedLinearConnection();
    linearWebhookIds = ["linear-webhook-replacement"];

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token-new",
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(linearWebhookRequests[0]?.body.variables.url).toBe(
      "https://api.example.test/webhooks/linear/linear-key",
    );
    expect(linearWebhookDeleteRequests).toEqual([
      { authorization: "linear-api-token-old", id: "linear-webhook-old" },
    ]);
    expect(linearLifecycleEvents).toEqual([
      "create:linear-webhook-replacement",
      "commit",
      "delete:linear-webhook-old",
    ]);
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.updated_at).not.toBe(expectedUpdatedAt);
    expect(state.connections[0]?.config_json).toEqual({
      linear_webhook_id: "linear-webhook-replacement",
    });
    expect(state.connections[0]?.status).toBe("active");
    expect(JSON.parse(decryptCredentialPayload(state.credentials[0]?.encrypted_payload, "v1"))).toEqual({
      api_token: "linear-api-token-new",
      webhook_secret: linearWebhookRequests[0]?.body.variables.secret,
    });
  });

  it("keeps the replacement authoritative and records safe pending cleanup when old deletion fails", async () => {
    seedLinearConnection();
    linearWebhookIds = ["linear-webhook-replacement"];
    linearWebhookDeleteFailures.add("linear-webhook-old");

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token-new-canary",
      }) as never,
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({ ok: true, cleanup_pending: true });
    expect(responseText).not.toContain("linear-api-token-new-canary");
    expect(responseText).not.toContain("linear-api-token-old");
    expect(state.connections[0]?.config_json).toEqual({
      linear_webhook_id: "linear-webhook-replacement",
      linear_cleanup_pending_webhook_ids: ["linear-webhook-old"],
    });
    expect(state.connections[0]?.status).toBe("degraded");
    expect(state.connections[0]?.last_error_at).not.toBeNull();
    expect(JSON.parse(decryptCredentialPayload(state.credentials[0]?.encrypted_payload, "v1"))).toMatchObject({
      api_token: "linear-api-token-new-canary",
    });
  });

  it("keeps the prior Linear webhook durable when clearing cleanup state hits a database error", async () => {
    seedLinearConnection();
    linearWebhookIds = ["linear-webhook-replacement"];
    sourceConnectionUpdateError = { message: "cleanup state unavailable" };

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token-new",
      }) as never,
    );
    await Bun.sleep(0);

    expect(await response.json()).toEqual({ ok: true, cleanup_pending: true });
    expect(state.connections[0]?.config_json).toEqual({
      linear_webhook_id: "linear-webhook-replacement",
      linear_cleanup_pending_webhook_ids: ["linear-webhook-old"],
    });
    expect(state.errors.some((error) =>
      error.detail_json.code === "linear_cleanup_state_failed"
    )).toBe(true);
  });

  it("keeps the prior Linear webhook durable when cleanup-state optimistic concurrency loses", async () => {
    seedLinearConnection();
    linearWebhookIds = ["linear-webhook-replacement"];
    sourceConnectionBeforeUpdate = () => {
      state.connections[0]!.updated_at = "2026-08-20T20:30:00.000000+00:00";
    };

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, {
        provider: "linear",
        api_token: "linear-api-token-new",
      }) as never,
    );

    expect(await response.json()).toEqual({ ok: true, cleanup_pending: true });
    expect(state.connections[0]?.config_json).toEqual({
      linear_webhook_id: "linear-webhook-replacement",
      linear_cleanup_pending_webhook_ids: ["linear-webhook-old"],
    });
  });

  it("records the safe orphan webhook id when Linear commit compensation fails", async () => {
    state.connections = [];
    state.credentials = [];
    linearCommitError = { message: "database unavailable" };
    linearWebhookDeleteFailures.add("linear-webhook-new");
    linearWebhookDeleteRawDetail = "linear-provider-raw-canary";
    errorsInsertError = { message: "operator error insert unavailable" };
    const stderrLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = mock((value: unknown) => { stderrLines.push(String(value)); });

    let response: Response;
    let responseText: string;
    try {
      response = await routeModule.POST(
        request("POST", { id: workspaceId }, {
          provider: "linear",
          api_token: "linear-api-token-canary",
        }) as never,
      );
      responseText = await response.text();
      for (let attempt = 0; attempt < 20 && stderrLines.length < 2; attempt += 1) {
        await Bun.sleep(0);
      }
    } finally {
      console.error = originalConsoleError;
    }

    expect(response.status).toBe(500);
    expect(responseText).not.toContain("linear-api-token-canary");
    expect(state.errors).toHaveLength(0);
    const fallbackEvents = stderrLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const compensationError = fallbackEvents.find((event) =>
      event.code === "linear_webhook_compensation_failed"
    );
    expect(compensationError?.detail).toEqual({ linear_webhook_id: "linear-webhook-new" });
    const fallbackOutput = stderrLines.join("\n");
    expect(fallbackOutput).not.toContain("linear-api-token-canary");
    expect(fallbackOutput).not.toContain(String(linearWebhookRequests[0]?.body.variables.secret));
    expect(fallbackOutput).not.toContain("linear-provider-raw-canary");
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
      connections: [
        {
          provider: "slack",
          status: "active",
          display_name: "Slack",
          last_success_at: null,
          last_error_at: null,
          channel_ids: ["C-old"],
        },
        {
          provider: "claude_code",
          status: null,
          display_name: null,
          last_success_at: null,
          last_error_at: null,
          channel_ids: [],
          connected: false,
        },
      ],
    });
  });

  it("reports claude_code as connected once a token is stored", async () => {
    state.workspaces[0]!.inference_credential_id = "claude-code-credential";
    state.credentials.push({
      id: "claude-code-credential",
      workspace_id: workspaceId,
      provider: "claude_code",
      encrypted_payload: "irrelevant",
      encryption_key_version: "v1",
      status: "active",
    });

    const response = await routeModule.GET(request("GET", { id: workspaceId }) as never);
    const body = await response.json() as {
      connections: Array<{
        provider: string;
        connected?: boolean;
        status: string | null;
        display_name: string | null;
        last_success_at: string | null;
        last_error_at: string | null;
        channel_ids: string[];
      }>;
    };
    const claudeCode = body.connections.find((connection) => connection.provider === "claude_code");
    expect(claudeCode).toEqual({
      provider: "claude_code",
      status: "active",
      display_name: null,
      last_success_at: null,
      last_error_at: null,
      channel_ids: [],
      connected: true,
    });
  });

  it("stores a claude_code token as a workspace-level credential, not a source_connections row", async () => {
    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "claude_code", token: "sk-ant-oat01-token" }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.connections).toHaveLength(1); // unchanged — still just the seeded Slack connection
    const claudeCodeCredential = state.credentials.find((credential) => credential.provider === "claude_code");
    expect(claudeCodeCredential).toBeDefined();
    expect(claudeCodeCredential?.status).toBe("active");
    expect(decryptCredentialPayload(claudeCodeCredential?.encrypted_payload, "v1")).toBe("sk-ant-oat01-token");
    expect(state.workspaces[0]?.inference_credential_id).toBe(claudeCodeCredential?.id ?? null);
  });

  it("re-connecting claude_code updates the existing credential in place", async () => {
    await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "claude_code", token: "first-token" }) as never,
    );
    const firstCredentialId = state.workspaces[0]?.inference_credential_id;

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "claude_code", token: "second-token" }) as never,
    );

    expect(response.status).toBe(200);
    expect(state.credentials.filter((credential) => credential.provider === "claude_code")).toHaveLength(1);
    expect(state.workspaces[0]?.inference_credential_id).toBe(firstCredentialId);
    const credential = state.credentials.find((c) => c.id === firstCredentialId);
    expect(decryptCredentialPayload(credential?.encrypted_payload, "v1")).toBe("second-token");
  });

  it("rejects DELETE for claude_code instead of silently no-oping", async () => {
    const response = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "claude_code" }) as never,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not_supported" });
  });

  it("returns live Slack channel titles and membership", async () => {
    const response = await routeModule.CHANNELS_GET(
      request("GET", { id: workspaceId, provider: "slack" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channels: [
        { id: "C-other", name: "announcements", memberCount: 20, isMember: false },
        { id: "C-old", name: "product-planning", memberCount: 8, isMember: true },
      ],
    });
  });

  it("joins additions, leaves removals, and persists the converged Slack membership", async () => {
    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, { channel_ids: ["C-new"] }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channel_ids: ["C-new"],
      joined: ["C-new"],
      left: ["C-old"],
      failed: [],
    });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new"] });
    expect(slackJoinCalls).toEqual(["C-new"]);
    expect(slackLeaveCalls).toEqual(["C-old"]);
  });

  it("accepts an empty Slack selection and leaves every configured channel", async () => {
    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, { channel_ids: [] }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      channel_ids: [],
      joined: [],
      left: ["C-old"],
      failed: [],
    });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: [] });
    expect(slackLeaveCalls).toEqual(["C-old"]);
  });

  it("persists only converged Slack membership on a partial failure", async () => {
    slackMembershipFailures.add("join:C-failed");
    slackMembershipFailures.add("leave:C-old");

    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, {
        channel_ids: ["C-new", "C-failed"],
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      channel_ids: ["C-new", "C-old"],
      joined: ["C-new"],
      left: [],
      failed: [
        { channel_id: "C-failed", operation: "join", code: "slack_channel_join_failed" },
        { channel_id: "C-old", operation: "leave", code: "slack_channel_leave_failed" },
      ],
    });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new", "C-old"] });
  });

  it("retries from persisted converged Slack membership without repeating completed changes", async () => {
    slackMembershipFailures.add("leave:C-old");
    await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, { channel_ids: ["C-new"] }) as never,
    );
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new", "C-old"] });

    slackMembershipFailures.clear();
    slackJoinCalls = [];
    slackLeaveCalls = [];
    const retry = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, { channel_ids: ["C-new"] }) as never,
    );

    expect(await retry.json()).toEqual({
      ok: true,
      channel_ids: ["C-new"],
      joined: [],
      left: ["C-old"],
      failed: [],
    });
    expect(slackJoinCalls).toEqual([]);
    expect(slackLeaveCalls).toEqual(["C-old"]);
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-new"] });
  });

  it("retries a concurrent Slack PATCH until provider and persisted membership converge", async () => {
    const concurrentStatuses: number[] = [];
    sourceConnectionBeforeUpdate = async () => {
      const concurrentResponse = await routeModule.PATCH(
        request("PATCH", { id: workspaceId, provider: "slack" }, {
          channel_ids: ["C-concurrent"],
        }) as never,
      );
      concurrentStatuses.push(concurrentResponse.status);
    };

    const response = await routeModule.PATCH(
      request("PATCH", { id: workspaceId, provider: "slack" }, {
        channel_ids: ["C-final"],
      }) as never,
    );

    expect(concurrentStatuses).toEqual([200]);
    expect(await response.json()).toEqual({
      ok: true,
      channel_ids: ["C-final"],
      joined: ["C-final"],
      left: ["C-concurrent"],
      failed: [],
    });
    expect(state.connections[0]?.config_json).toEqual({ channel_ids: ["C-final"] });
    expect([...slackProviderMembership]).toEqual(["C-final"]);
    expect(slackJoinCalls).toEqual(["C-final", "C-concurrent", "C-final"]);
    expect(slackLeaveCalls).toEqual(["C-old", "C-old", "C-concurrent"]);
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
    expect(await response.json()).toEqual({ error: "slack_channel_join_failed" });
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
    expect(stoppedSlackListeners).toEqual(["slack-connection"]);
  });

  it("does not stop the Slack listener when the disconnect RPC fails", async () => {
    disconnectRpcError = { message: "database unavailable" };

    const response = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "slack" }) as never,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "disconnect_failed" });
    expect(state.connections[0]?.status).toBe("active");
    expect(state.scheduledTasks[0]?.enabled).toBe(true);
    expect(stoppedSlackListeners).toEqual([]);
  });

  it("includes a connected github source in GET", async () => {
    state.connections.push({
      id: "github-connection",
      provider: "github" as unknown as Connection["provider"],
      credential_id: null,
      connection_key: "555",
      status: "active",
      display_name: "acme",
      last_success_at: null,
      last_error_at: null,
      config_json: {},
      workspace_id: workspaceId,
    });

    const response = await routeModule.GET(request("GET", { id: workspaceId }) as never);
    const body = (await response.json()) as { connections: Array<{ provider: string; status: string | null }> };
    const github = body.connections.find((connection) => connection.provider === "github");
    expect(github).toMatchObject({ provider: "github", status: "active" });
  });

  it("locally revokes a github connection without a credential to clean up", async () => {
    state.connections.push({
      id: "github-connection",
      provider: "github" as unknown as Connection["provider"],
      credential_id: null,
      connection_key: "555",
      status: "active",
      display_name: "acme",
      last_success_at: null,
      last_error_at: null,
      config_json: {},
      workspace_id: workspaceId,
    });

    const response = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "github" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const githubConnection = state.connections.find((connection) => connection.id === "github-connection");
    expect(githubConnection?.status).toBe("revoked");
  });

  it("rejects POST with provider: github -- it connects via install-session routes, not this endpoint", async () => {
    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "github" }) as never,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
  });

  it("claude_session: POST toggles the workspace on with no credential/webhook", async () => {
    state.connections = state.connections.filter((c) => c.provider !== "claude_session");

    const response = await routeModule.POST(
      request("POST", { id: workspaceId }, { provider: "claude_session" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const connection = state.connections.find((c) => c.provider === "claude_session");
    expect(connection?.status).toBe("active");
    expect(connection?.connection_key).toBe("agent-sessions");
  });

  it("claude_session: DELETE revokes without touching scheduled_tasks", async () => {
    state.connections.push({
      id: "claude-session-connection",
      provider: "claude_session",
      credential_id: null,
      connection_key: "agent-sessions",
      status: "active",
      display_name: null,
      last_success_at: null,
      last_error_at: null,
      config_json: {},
      workspace_id: workspaceId,
    });
    state.scheduledTasks = [];

    const response = await routeModule.DELETE(
      request("DELETE", { id: workspaceId, provider: "claude_session" }) as never,
    );
    expect(response.status).toBe(200);
    const connection = state.connections.find((c) => c.provider === "claude_session");
    expect(connection?.status).toBe("revoked");
    expect(state.scheduledTasks).toHaveLength(0);
  });
});

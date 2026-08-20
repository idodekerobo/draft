import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface SearchRow {
  source_item_id: string;
  agent_session_id: string | null;
  provider: string | null;
  user_id: string | null;
  contributor_id: string | null;
  occurred_at: string;
  snippet: string;
}

const state: {
  searchRows: SearchRow[];
  users: { id: string; display_name: string | null; email: string }[];
  contributors: { id: string; git_display_name: string | null; git_email: string }[];
  rpcParams: Record<string, unknown> | null;
  queryLog: Record<string, unknown>[];
} = { searchRows: [], users: [], contributors: [], rpcParams: null, queryLog: [] };

let accessResult: Response | null = null;

function createFakeClient() {
  return {
    from(table: string) {
      if (table === "agent_query_log") {
        return { insert(payload: Record<string, unknown>) { state.queryLog.push(payload); return Promise.resolve({ error: null }); } };
      }
      const filters: Array<[string, string, unknown]> = [];
      const builder: Record<string, any> = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters.push(["eq", column, value]); return builder; },
        in(column: string, values: unknown[]) { filters.push(["in", column, values]); return builder; },
        async maybeSingle() {
          const result = await execute();
          return { data: (result.data as unknown[])[0] ?? null, error: result.error };
        },
        then(resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) {
          return execute().then(resolve, reject);
        },
      };

      async function execute() {
        const source =
          table === "users" ? state.users :
          table === "session_contributors" ? state.contributors :
          null;
        if (!source) throw new Error(`Unexpected table: ${table}`);
        let rows = source as Record<string, unknown>[];
        for (const [kind, column, value] of filters) {
          if (kind === "eq") rows = rows.filter((r) => r[column] === value);
          if (kind === "in") rows = rows.filter((r) => (value as unknown[]).includes(r[column]));
        }
        return { data: rows, error: null };
      }

      return builder;
    },
    async rpc(fnName: string, params: Record<string, unknown>) {
      if (fnName !== "search_source_items") throw new Error(`Unexpected rpc: ${fnName}`);
      state.rpcParams = params;
      return { data: state.searchRows, error: null };
    },
  };
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));

const routeModule = await import("../../routes/sessions-search");

beforeEach(() => {
  accessResult = null;
  state.searchRows = [];
  state.users = [];
  state.contributors = [];
  state.rpcParams = null;
  state.queryLog = [];
});

function searchRequest(query: string): Request {
  return Object.assign(new Request(`https://internal.test/workspaces/${workspaceId}/sessions/search${query}`), { params: { id: workspaceId } });
}

describe("GET /workspaces/:id/sessions/search", () => {
  it("requires q", async () => {
    const response = await routeModule.GET(searchRequest("") as never);
    expect(response.status).toBe(400);
  });

  it("returns matches with resolved display names and never the full content_markdown", async () => {
    state.searchRows.push({
      source_item_id: "item-1", agent_session_id: "session-1", provider: "claude-code-session",
      user_id: "user-1", contributor_id: null, occurred_at: "2026-01-01T00:00:00Z", snippet: "...database <b>migration</b>...",
    });
    state.users.push({ id: "user-1", display_name: "Ada", email: "ada@example.com" });

    const response = await routeModule.GET(searchRequest("?q=migration") as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessions: any[] };
    expect(body.sessions).toEqual([{
      session_id: "item-1", agent_session_id: "session-1", provider: "claude-code-session",
      verified: true, display: "Ada", occurred_at: "2026-01-01T00:00:00Z", snippet: "...database <b>migration</b>...",
    }]);
    expect(body.sessions[0]).not.toHaveProperty("content_markdown");
  });

  it("resolves --user by email before calling the RPC", async () => {
    state.users.push({ id: "user-1", display_name: "Ada", email: "ada@example.com" });
    await routeModule.GET(searchRequest("?q=migration&user=ada@example.com") as never);
    expect(state.rpcParams).toMatchObject({ p_user_id: "user-1", p_contributor_id: null });
  });

  it("short-circuits to an empty result when --user matches nobody", async () => {
    const response = await routeModule.GET(searchRequest("?q=migration&user=nobody@example.com") as never);
    const body = await response.json() as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
    expect(state.rpcParams).toBeNull();
  });

  it("returns the workspace access denial before searching", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.GET(searchRequest("?q=x") as never);
    expect(response.status).toBe(403);
  });

  it("records a sessions.search query-log entry", async () => {
    await routeModule.GET(searchRequest("?q=migration") as never);
    expect(state.queryLog).toHaveLength(1);
    expect(state.queryLog[0]).toMatchObject({ workspace_id: workspaceId, command: "sessions.search" });
  });
});

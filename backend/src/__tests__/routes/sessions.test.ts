import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface SessionRow {
  id: string;
  workspace_id: string;
  provider: string;
  user_id: string | null;
  contributor_id: string | null;
  project: string | null;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary_status: string;
}

interface MessageRow {
  session_id: string;
  workspace_id: string;
  seq: number;
  role: string;
  content: string;
}

interface SourceItemRow {
  workspace_id: string;
  item_type: string;
  lifecycle_status: string;
  metadata_json: Record<string, unknown>;
  content_markdown: string;
  occurred_at: string;
}

const state: {
  sessions: SessionRow[];
  messages: MessageRow[];
  sourceItems: SourceItemRow[];
  users: { id: string; display_name: string | null; email: string }[];
  contributors: { id: string; git_display_name: string | null; git_email: string }[];
} = { sessions: [], messages: [], sourceItems: [], users: [], contributors: [] };

let accessResult: Response | null = null;

function createFakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let sort: { column: string; ascending: boolean } | null = null;
      const builder: Record<string, any> = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters.push(["eq", column, value]); return builder; },
        gte(column: string, value: unknown) { filters.push(["gte", column, value]); return builder; },
        in(column: string, values: unknown[]) { filters.push(["in", column, values]); return builder; },
        contains(column: string, value: Record<string, unknown>) { filters.push(["contains", column, value]); return builder; },
        order(column: string, opts?: { ascending?: boolean }) { sort = { column, ascending: opts?.ascending ?? true }; return builder; },
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
          table === "agent_sessions" ? state.sessions :
          table === "agent_messages" ? state.messages :
          table === "source_items" ? state.sourceItems :
          table === "users" ? state.users :
          table === "session_contributors" ? state.contributors :
          null;
        if (!source) throw new Error(`Unexpected table: ${table}`);

        let rows = source as Record<string, unknown>[];
        for (const [kind, column, value] of filters) {
          if (kind === "eq") rows = rows.filter((r) => r[column] === value);
          if (kind === "gte") rows = rows.filter((r) => (r[column] as string) >= (value as string));
          if (kind === "in") rows = rows.filter((r) => (value as unknown[]).includes(r[column]));
          if (kind === "contains") {
            rows = rows.filter((r) => {
              const meta = r[column] as Record<string, unknown>;
              return Object.entries(value as Record<string, unknown>).every(([k, v]) => meta?.[k] === v);
            });
          }
        }
        if (sort) {
          const { column, ascending } = sort;
          rows = [...rows].sort((a, b) => {
            const av = a[column] as string | number;
            const bv = b[column] as string | number;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return ascending ? cmp : -cmp;
          });
        }
        return { data: rows, error: null };
      }

      return builder;
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

const routeModule = await import("../../routes/sessions");

beforeEach(() => {
  accessResult = null;
  state.sessions = [];
  state.messages = [];
  state.sourceItems = [];
  state.users = [];
  state.contributors = [];
});

function listRequest(query = ""): Request {
  return Object.assign(new Request(`https://internal.test/workspaces/${workspaceId}/sessions${query}`), { params: { id: workspaceId } });
}

function readRequest(sessionId: string, query = ""): Request {
  return Object.assign(new Request(`https://internal.test/workspaces/${workspaceId}/sessions/${sessionId}${query}`), {
    params: { id: workspaceId, sessionId },
  });
}

describe("GET /workspaces/:id/sessions", () => {
  it("lists sessions with verified user display and has_summary derived from summary_status", async () => {
    state.sessions.push({
      id: "s1", workspace_id: workspaceId, provider: "claude-code-session", user_id: "user-1", contributor_id: null,
      project: "flooently", cwd: "/repo", started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "unknown", summary_status: "ok",
    });
    state.users.push({ id: "user-1", display_name: "Ada", email: "ada@example.com" });

    const response = await routeModule.GET(listRequest() as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessions: any[] };
    expect(body.sessions).toEqual([{
      id: "s1", provider: "claude-code-session", verified: true, display: "Ada", project: "flooently", cwd: "/repo",
      started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "unknown", summary_status: "ok", has_summary: true,
    }]);
  });

  it("shows contributor display and has_summary:false for pending summaries", async () => {
    state.sessions.push({
      id: "s2", workspace_id: workspaceId, provider: "claude-code-session", user_id: null, contributor_id: "c1",
      project: null, cwd: null, started_at: "2026-01-02T00:00:00Z", ended_at: null, status: "unknown", summary_status: "pending",
    });
    state.contributors.push({ id: "c1", git_display_name: null, git_email: "dev@example.com" });

    const response = await routeModule.GET(listRequest() as never);
    const body = await response.json() as { sessions: any[] };
    expect(body.sessions[0]).toMatchObject({ verified: false, display: "dev@example.com", has_summary: false });
  });

  it("filters by provider/user/since", async () => {
    state.sessions.push(
      { id: "s1", workspace_id: workspaceId, provider: "claude-code-session", user_id: "user-1", contributor_id: null, project: null, cwd: null, started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "x", summary_status: "pending" },
      { id: "s2", workspace_id: workspaceId, provider: "hermes-session", user_id: null, contributor_id: null, project: null, cwd: null, started_at: "2026-01-02T00:00:00Z", ended_at: null, status: "x", summary_status: "pending" },
    );

    const response = await routeModule.GET(listRequest("?provider=hermes-session") as never);
    const body = await response.json() as { sessions: any[] };
    expect(body.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("returns the workspace access denial before querying", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.GET(listRequest() as never);
    expect(response.status).toBe(403);
  });
});

describe("GET /workspaces/:id/sessions/:sessionId", () => {
  beforeEach(() => {
    state.sessions.push({
      id: "s1", workspace_id: workspaceId, provider: "claude-code-session", user_id: "user-1", contributor_id: null,
      project: "flooently", cwd: "/repo", started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "unknown", summary_status: "ok",
    });
  });

  it("404s identically for a nonexistent session", async () => {
    const response = await routeModule.READ(readRequest("nonexistent") as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not_found" });
  });

  it("404s identically for a session in a different workspace (tenant-leak-safe)", async () => {
    state.sessions.push({
      id: "s-other", workspace_id: "workspace-B", provider: "claude-code-session", user_id: null, contributor_id: null,
      project: null, cwd: null, started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "unknown", summary_status: "pending",
    });
    const response = await routeModule.READ(readRequest("s-other") as never);
    expect(response.status).toBe(404);
  });

  it("returns null summary when no summary source_item exists yet", async () => {
    const response = await routeModule.READ(readRequest("s1") as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: null });
  });

  it("returns the summary content when a coding_session source_item is linked", async () => {
    state.sourceItems.push({
      workspace_id: workspaceId, item_type: "coding_session", lifecycle_status: "ready",
      metadata_json: { agent_session_id: "s1" }, content_markdown: "# Summary", occurred_at: "2026-01-01T00:00:00Z",
    });
    const response = await routeModule.READ(readRequest("s1") as never);
    expect(await response.json()).toEqual({ summary: "# Summary", occurred_at: "2026-01-01T00:00:00Z" });
  });

  it("--transcript returns messages ordered by seq", async () => {
    state.messages.push(
      { session_id: "s1", workspace_id: workspaceId, seq: 1, role: "assistant", content: "hello" },
      { session_id: "s1", workspace_id: workspaceId, seq: 0, role: "user", content: "hi" },
    );
    const response = await routeModule.READ(readRequest("s1", "?transcript") as never);
    const body = await response.json() as { messages: { seq: number }[] };
    expect(body.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("returns the workspace access denial before lookup", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.READ(readRequest("s1") as never);
    expect(response.status).toBe(403);
  });
});

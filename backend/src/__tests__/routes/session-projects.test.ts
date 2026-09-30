import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let accessResult: Response | null = null;

function createFakeClient() {
  return {
    from(table: string) {
      const source = tables[table];
      if (!source) throw new Error(`Unexpected table: ${table}`);
      return {
        select() {
          let rows = [...source];
          let ordering: { column: string; ascending: boolean } | null = null;
          const builder = {
            eq(column: string, value: unknown) {
              rows = rows.filter((r) => r[column] === value);
              return builder;
            },
            in(column: string, values: unknown[]) {
              rows = rows.filter((r) => values.includes(r[column]));
              return builder;
            },
            order(column: string, options: { ascending: boolean }) {
              ordering = { column, ascending: options.ascending };
              return builder;
            },
            then(resolve: (value: { data: Row[]; error: null }) => unknown) {
              const out = ordering
                ? rows.sort((a, b) => String(a[ordering!.column]).localeCompare(String(b[ordering!.column])) * (ordering!.ascending ? 1 : -1))
                : rows;
              return Promise.resolve({ data: out, error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
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

const routeModule = await import("../../routes/session-projects");

function credential(projectId: string, overrides: Row = {}): Row {
  return {
    workspace_id: workspaceId,
    provider: "agent_session_ingest",
    session_project_id: projectId,
    status: "active",
    expires_at: null,
    created_by_user_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function session(projectId: string, startedAt: string, who: Row): Row {
  return { workspace_id: workspaceId, session_project_id: projectId, started_at: startedAt, user_id: null, contributor_id: null, ...who };
}

beforeEach(() => {
  accessResult = null;
  tables.session_projects = [
    { id: "p1", workspace_id: workspaceId, label: "api", status: "active", created_at: "2026-09-01T00:00:00.000Z" },
    { id: "p2", workspace_id: workspaceId, label: "web", status: "active", created_at: "2026-09-02T00:00:00.000Z" },
    { id: "p3", workspace_id: workspaceId, label: "old", status: "archived", created_at: "2026-08-01T00:00:00.000Z" },
  ];
  tables.credentials = [credential("p1"), credential("p2")];
  tables.agent_sessions = [];
  tables.users = [
    { id: "user-1", display_name: "Ana", email: "ana@example.com" },
    { id: "user-2", display_name: null, email: "kai@example.com" },
  ];
  tables.session_contributors = [{ id: "c1", git_display_name: "Lee", git_email: "lee@example.com" }];
});

function request(): Request {
  return Object.assign(new Request("https://internal.test"), { params: { id: workspaceId } });
}

async function list() {
  const response = await routeModule.GET(request() as never);
  return { response, body: await response.json() as { projects: Record<string, any>[] } };
}

describe("GET /workspaces/:id/sessions/projects", () => {
  it("returns the workspace access denial", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const { response } = await list();
    expect(response.status).toBe(403);
  });

  it("lists only active repos with a live credential", async () => {
    tables.credentials = [
      credential("p1"),
      credential("p2", { expires_at: past }),
      credential("p3"),
    ];
    const { body } = await list();
    expect(body.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("keeps a repo in its rotation grace window and drops a revoked one", async () => {
    tables.credentials = [credential("p1", { expires_at: future }), credential("p2", { status: "revoked" })];
    const { body } = await list();
    expect(body.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("reports the original creator, or null for an old credential", async () => {
    tables.credentials = [
      credential("p1", { created_by_user_id: "user-2", created_at: "2026-09-01T00:00:00.000Z" }),
      credential("p1", { created_by_user_id: "user-1", created_at: "2026-09-05T00:00:00.000Z" }),
      credential("p2"),
    ];
    const { body } = await list();
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]));
    expect(byId.p1.created_by).toEqual({ user_id: "user-2", display: "kai@example.com", is_me: false });
    expect(byId.p2.created_by).toBeNull();
  });

  it("aggregates contributors, last upload and session count, and marks the caller", async () => {
    tables.agent_sessions = [
      session("p1", "2026-09-10T00:00:00.000Z", { user_id: "user-1" }),
      session("p1", "2026-09-12T00:00:00.000Z", { user_id: "user-2" }),
      session("p1", "2026-09-11T00:00:00.000Z", { contributor_id: "c1" }),
      session("p1", "2026-09-09T00:00:00.000Z", { user_id: "user-1" }),
    ];
    const { body } = await list();
    const p1 = body.projects.find((p) => p.id === "p1")!;
    expect(p1.session_count).toBe(4);
    expect(p1.last_upload_at).toBe("2026-09-12T00:00:00.000Z");
    expect(p1.contributors).toEqual([
      { display: "kai@example.com", is_me: false, verified: true },
      { display: "Lee", is_me: false, verified: false },
      { display: "Ana", is_me: true, verified: true },
    ]);
  });

  it("sorts repos with uploads first, most recent first", async () => {
    tables.agent_sessions = [session("p2", "2026-09-10T00:00:00.000Z", { user_id: "user-1" })];
    const { body } = await list();
    expect(body.projects.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(body.projects[1]?.last_upload_at).toBeNull();
    expect(body.projects[1]?.contributors).toEqual([]);
  });

  it("returns an empty list when the workspace has no repos", async () => {
    tables.session_projects = [];
    const { body } = await list();
    expect(body.projects).toEqual([]);
  });
});

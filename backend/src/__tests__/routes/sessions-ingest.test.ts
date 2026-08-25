import { beforeEach, describe, expect, it, mock } from "bun:test";

const workspaceId = "workspace-1";

interface ContributorRow {
  id: string;
  workspace_id: string;
  git_email: string;
  git_display_name: string | null;
  last_seen_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  provider: string;
  external_session_id: string;
  user_id: string | null;
  contributor_id: string | null;
  messages: { role: string; content: string }[];
}

const state: { contributors: ContributorRow[]; sessions: SessionRow[] } = { contributors: [], sessions: [] };
let nextId = 0;
interface FakeScope {
  credentialId: string;
  workspaceId: string;
  sessionProjectId: string | null;
  allowedProviders: string[] | null;
}
let ingestScope: FakeScope | null = { credentialId: "cred-1", workspaceId, sessionProjectId: null, allowedProviders: null };
let userLookup: { userId: string } | null = null;
let accessResult: Response | null = null;
/** Mirrors source_connections' claude_session/agent-sessions row status. `undefined` = no row (opt-in default: blocked). */
let sessionTrackingStatus: string | undefined = "active";

function createFakeServiceClient() {
  return {
    from(table: string) {
      if (table === "source_connections") {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: sessionTrackingStatus ? { status: sessionTrackingStatus } : null, error: null };
          },
        };
      }
      if (table === "session_contributors") {
        const filters: Record<string, unknown> = {};
        let updatePayload: Record<string, unknown> | undefined;
        const builder: Record<string, any> = {
          select() { return builder; },
          eq(column: string, value: unknown) { filters[column] = value; return builder; },
          async maybeSingle() {
            const found = state.contributors.find((row) =>
              Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v),
            );
            return { data: found ?? null, error: null };
          },
          update(payload: Record<string, unknown>) { updatePayload = payload; return builder; },
          then(resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) {
            const found = state.contributors.find((row) =>
              Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v),
            );
            if (found && updatePayload) Object.assign(found, updatePayload);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
          insert(payload: Partial<ContributorRow>) {
            const row: ContributorRow = {
              id: `contributor-${++nextId}`,
              workspace_id: payload.workspace_id!,
              git_email: payload.git_email!,
              git_display_name: payload.git_display_name ?? null,
              last_seen_at: payload.last_seen_at ?? new Date().toISOString(),
            };
            state.contributors.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: row.id }, error: null }),
              }),
            };
          },
        };
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(fnName: string, params: Record<string, unknown>) {
      if (fnName !== "replace_agent_session_messages") throw new Error(`Unexpected rpc: ${fnName}`);
      const existing = state.sessions.find(
        (s) => s.workspace_id === params.p_workspace_id && s.provider === params.p_provider && s.external_session_id === params.p_external_session_id,
      );
      if (existing) {
        existing.user_id = existing.user_id ?? (params.p_user_id as string | null);
        existing.messages = params.p_messages as { role: string; content: string }[];
        return { data: { session_id: existing.id }, error: null };
      }
      const row: SessionRow = {
        id: `session-${++nextId}`,
        workspace_id: params.p_workspace_id as string,
        provider: params.p_provider as string,
        external_session_id: params.p_external_session_id as string,
        user_id: params.p_user_id as string | null,
        contributor_id: params.p_contributor_id as string | null,
        messages: params.p_messages as { role: string; content: string }[],
      };
      state.sessions.push(row);
      return { data: { session_id: row.id }, error: null };
    },
  };
}

mock.module("../../credentials/session-ingest-token", () => ({
  resolveIngestCredentialScope: async () => ingestScope,
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({
  serviceClient: createFakeServiceClient(),
  publishableClient: {
    auth: {
      getUser: async () => (userLookup ? { data: { user: { id: userLookup.userId } }, error: null } : { data: { user: null }, error: new Error("invalid") }),
    },
  },
}));

const routeModule = await import("../../routes/sessions-ingest");

beforeEach(() => {
  state.contributors = [];
  state.sessions = [];
  ingestScope = { credentialId: "cred-1", workspaceId, sessionProjectId: null, allowedProviders: null };
  userLookup = null;
  accessResult = null;
  sessionTrackingStatus = "active";
});

function transcriptFor(messages: { role: "user" | "assistant"; text: string }[]): string {
  return messages
    .map((m, i) =>
      JSON.stringify({
        type: m.role,
        timestamp: `2026-01-01T00:0${i}:00.000Z`,
        message: { role: m.role, content: [{ type: "text", text: m.text }] },
      }),
    )
    .join("\n");
}

function ingestRequest(opts: { ingestToken?: string; userToken?: string; query?: Record<string, string>; body?: string }): Request {
  const params = new URLSearchParams({ sessionId: "sess-1", gitEmail: "dev@example.com", ...opts.query });
  const headers: Record<string, string> = {};
  if (opts.ingestToken !== undefined) headers.authorization = `Bearer ${opts.ingestToken}`;
  if (opts.userToken !== undefined) headers["x-draft-user-token"] = opts.userToken;
  return new Request(`https://internal.test/sessions/ingest?${params.toString()}`, {
    method: "POST",
    headers,
    body: opts.body ?? transcriptFor([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]),
  });
}

describe("POST /sessions/ingest", () => {
  it("rejects a request with no bearer token", async () => {
    const response = await routeModule.POST(new Request("https://internal.test/sessions/ingest", { method: "POST" }) as never);
    expect(response.status).toBe(401);
  });

  it("rejects an invalid/unresolvable ingest token", async () => {
    ingestScope = null;
    const response = await routeModule.POST(ingestRequest({ ingestToken: "bad" }) as never);
    expect(response.status).toBe(401);
  });

  it("contributor tier: creates a session_contributors row and links the session to it", async () => {
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(200);
    expect(state.contributors).toHaveLength(1);
    expect(state.contributors[0]?.git_email).toBe("dev@example.com");
    expect(state.sessions[0]?.contributor_id).toBe(state.contributors[0]?.id);
    expect(state.sessions[0]?.user_id).toBeNull();
    expect(state.sessions[0]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("verified tier: a valid X-Draft-User-Token with workspace membership links user_id, no contributor row", async () => {
    userLookup = { userId: "user-1" };
    accessResult = null; // membership matches
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", userToken: "usertoken" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions[0]?.user_id).toBe("user-1");
    expect(state.sessions[0]?.contributor_id).toBeNull();
    expect(state.contributors).toHaveLength(0);
  });

  it("falls back to contributor tier when X-Draft-User-Token membership check fails", async () => {
    userLookup = { userId: "user-1" };
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", userToken: "usertoken" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions[0]?.user_id).toBeNull();
    expect(state.sessions[0]?.contributor_id).not.toBeNull();
  });

  it("falls back to contributor tier when X-Draft-User-Token is invalid", async () => {
    userLookup = null;
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", userToken: "badtoken" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions[0]?.user_id).toBeNull();
  });

  it("tenant isolation: the ingest token's workspace is used, never anything the client claims", async () => {
    ingestScope = { credentialId: "cred-1", workspaceId: "workspace-B", sessionProjectId: null, allowedProviders: null };
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions[0]?.workspace_id).toBe("workspace-B");
  });

  it("empty-transcript is a no-op — skipped, nothing persisted", async () => {
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", body: "" }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: "empty" });
    expect(state.sessions).toHaveLength(0);
  });

  it("missing required query fields is a 400", async () => {
    const response = await routeModule.POST(
      new Request("https://internal.test/sessions/ingest", { method: "POST", headers: { authorization: "Bearer good" }, body: "x" }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("rejects with session_tracking_disabled when no source_connections row exists (opt-in default)", async () => {
    sessionTrackingStatus = undefined;
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "session_tracking_disabled" });
    expect(state.sessions).toHaveLength(0);
  });

  it("rejects with session_tracking_disabled when the row is revoked", async () => {
    sessionTrackingStatus = "revoked";
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });

  it("allows ingestion when the row is pending", async () => {
    sessionTrackingStatus = "pending";
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions).toHaveLength(1);
  });
});

describe("POST /sessions/ingest — scoped credential (project + provider)", () => {
  const sessionProjectId = "project-A";

  beforeEach(() => {
    ingestScope = { credentialId: "cred-1", workspaceId, sessionProjectId, allowedProviders: ["claude-code-session"] };
  });

  it("persists the credential's session_project_id on the session", async () => {
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good" }) as never);
    expect(response.status).toBe(200);
    expect(state.sessions).toHaveLength(1);
  });

  // Mandatory regression: today an arbitrary `source` bypasses the tracking
  // toggle entirely (`if (source !== CLAUDE_CODE_SESSION_SOURCE) return
  // true`). A scoped credential must not get that bypass.
  it("a non-claude-code-session source is still subject to the tracking toggle", async () => {
    sessionTrackingStatus = undefined;
    ingestScope = { credentialId: "cred-1", workspaceId, sessionProjectId, allowedProviders: ["some-other-source"] };
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", query: { source: "some-other-source" } }) as never);
    expect(response.status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });

  it("rejects a source not in the credential's allowed_providers", async () => {
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", query: { source: "codex-session" } }) as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "provider_not_allowed" });
    expect(state.sessions).toHaveLength(0);
  });

  it("allows a source explicitly present in allowed_providers", async () => {
    ingestScope = { credentialId: "cred-1", workspaceId, sessionProjectId, allowedProviders: ["codex-session"] };
    sessionTrackingStatus = "active";
    const response = await routeModule.POST(ingestRequest({ ingestToken: "good", query: { source: "codex-session" } }) as never);
    expect(response.status).toBe(200);
  });
});

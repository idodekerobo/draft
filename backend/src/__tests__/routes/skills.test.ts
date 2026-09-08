import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;

interface FakeRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, unknown> | null;
  allowed_tools: string | null;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  removed_at: string | null;
}

let rows: FakeRow[] = [];
let insertError: { code: string; message: string } | null = null;
let nextId = 1;

function activeRows(workspaceId: string): FakeRow[] {
  return rows.filter((r) => r.workspace_id === workspaceId && r.removed_at === null);
}

function queryBuilder(table: string) {
  if (table !== "skills") throw new Error(`unexpected table: ${table}`);

  const filters: { workspaceId?: string; name?: string } = {};
  let mode: "select" | "insert" | "update" = "select";
  let insertPayload: Partial<FakeRow> | undefined;
  let updatePayload: Partial<FakeRow> | undefined;

  const builder = {
    select: () => builder,
    insert: (payload: Partial<FakeRow>) => { mode = "insert"; insertPayload = payload; return builder; },
    update: (payload: Partial<FakeRow>) => { mode = "update"; updatePayload = payload; return builder; },
    eq: (col: string, value: string) => {
      if (col === "workspace_id") filters.workspaceId = value;
      if (col === "name") filters.name = value;
      return builder;
    },
    is: () => builder,
    order: () => builder,
    // Both `select`/read lookups and PATCH/DELETE's combined
    // filter-and-update land here — real skills.ts always scopes update
    // queries to (workspace_id, name, removed_at IS NULL) and reads the
    // result back through the same call.
    async maybeSingle() {
      if (mode === "update") {
        const existing = rows.find(
          (r) => r.workspace_id === filters.workspaceId && r.name === filters.name && r.removed_at === null,
        );
        if (!existing) return { data: null, error: null };
        Object.assign(existing, updatePayload);
        return { data: existing, error: null };
      }
      const match = activeRows(filters.workspaceId ?? "").find((r) => r.name === filters.name);
      return { data: match ?? null, error: null };
    },
    async single() {
      if (insertError) return { data: null, error: insertError };
      const row: FakeRow = {
        id: `skill-${nextId++}`,
        workspace_id: insertPayload!.workspace_id as string,
        name: insertPayload!.name as string,
        description: insertPayload!.description as string,
        license: (insertPayload!.license as string | null) ?? null,
        compatibility: (insertPayload!.compatibility as string | null) ?? null,
        metadata: (insertPayload!.metadata as Record<string, unknown> | null) ?? null,
        allowed_tools: (insertPayload!.allowed_tools as string | null) ?? null,
        content: insertPayload!.content as string,
        created_by: insertPayload!.created_by as string,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        updated_by: null,
        removed_at: null,
      };
      rows.push(row);
      return { data: row, error: null };
    },
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({
  serviceClient: { from: (table: string) => queryBuilder(table) },
}));
mock.module("../../observability/record-query-log", () => ({
  recordAgentQueryLog: async () => {},
}));

const routeModule = await import("../../routes/skills");

function request(params: Record<string, string>, body?: unknown): Request {
  const init = body !== undefined ? { method: "POST", body: JSON.stringify(body) } : undefined;
  return Object.assign(new Request("http://internal.test", init), { params });
}

describe("skills routes", () => {
  beforeEach(() => {
    accessResult = null;
    rows = [];
    insertError = null;
    nextId = 1;
  });

  it("list returns zero skills for an empty workspace", async () => {
    const response = await routeModule.skillsGET(request({ id: "ws-1" }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills: [] });
  });

  it("add creates a skill from explicit fields", async () => {
    const response = await routeModule.skillsPOST(
      request({ id: "ws-1" }, { name: "email-template", description: "when to use", content: "body" }) as never,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe("email-template");
    expect(body.content).toBe("body");
  });

  it("add parses name/description from YAML frontmatter when flags are omitted", async () => {
    const content = "---\nname: from-frontmatter\ndescription: parsed desc\n---\nbody text";
    const response = await routeModule.skillsPOST(request({ id: "ws-1" }, { content }) as never);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe("from-frontmatter");
    expect(body.description).toBe("parsed desc");
  });

  it("explicit fields override frontmatter values", async () => {
    const content = "---\nname: frontmatter-name\ndescription: frontmatter-desc\n---\nbody";
    const response = await routeModule.skillsPOST(
      request({ id: "ws-1" }, { name: "explicit-name", content }) as never,
    );
    const body = await response.json();
    expect(body.name).toBe("explicit-name");
    expect(body.description).toBe("frontmatter-desc");
  });

  it("rejects malformed YAML frontmatter", async () => {
    const content = "---\nname: [unterminated\n---\nbody";
    const response = await routeModule.skillsPOST(request({ id: "ws-1" }, { content }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("malformed_frontmatter");
  });

  it("rejects a name that fails the spec regex", async () => {
    const response = await routeModule.skillsPOST(
      request({ id: "ws-1" }, { name: "Bad_Name", description: "d", content: "c" }) as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_name");
  });

  it("rejects missing name/description with no frontmatter", async () => {
    const response = await routeModule.skillsPOST(request({ id: "ws-1" }, { content: "just body text" }) as never);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("missing_required_fields");
  });

  it("rejects a duplicate active name", async () => {
    insertError = { code: "23505", message: "duplicate key" };
    const response = await routeModule.skillsPOST(
      request({ id: "ws-1" }, { name: "dup", description: "d", content: "c" }) as never,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("duplicate_name");
  });

  it("read 404s for an unknown skill", async () => {
    const response = await routeModule.skillsREAD(request({ id: "ws-1", name: "nope" }) as never);
    expect(response.status).toBe(404);
  });

  it("update replaces content and sets updated_by, then remove soft-deletes it", async () => {
    await routeModule.skillsPOST(request({ id: "ws-1" }, { name: "s", description: "d", content: "v1" }) as never);

    const updateResponse = await routeModule.skillsPATCH(
      request({ id: "ws-1", name: "s" }, { description: "d2", content: "v2" }) as never,
    );
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.content).toBe("v2");
    expect(updated.updatedBy).toBe("user-1");

    const removeResponse = await routeModule.skillsDELETE(request({ id: "ws-1", name: "s" }) as never);
    expect(removeResponse.status).toBe(200);

    const readAfterRemove = await routeModule.skillsREAD(request({ id: "ws-1", name: "s" }) as never);
    expect(readAfterRemove.status).toBe(404);
  });

  it("update on an unknown name 404s", async () => {
    const response = await routeModule.skillsPATCH(
      request({ id: "ws-1", name: "missing" }, { description: "d", content: "x" }) as never,
    );
    expect(response.status).toBe(404);
  });

  it("returns an access denial without querying skills", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.skillsGET(request({ id: "ws-1" }) as never);
    expect(response.status).toBe(403);
  });
});

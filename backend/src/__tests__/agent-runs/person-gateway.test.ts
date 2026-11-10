import { beforeEach, describe, expect, it } from "bun:test";
import { callPersonTool, listPersonTools } from "../../agent-runs/person-gateway";
import { createDraftToolRegistry } from "../../agent-runs/tools";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
let refusal: { status: number; body: unknown } | null = null;

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


// The real registry and the real call path, over a fake database client passed in. No module is mocked.
const fakeClient = { from: (table: string) => queryBuilder(table) } as never;
const deps = {
  registry: createDraftToolRegistry(fakeClient),
  audit: async () => {},
  authorizeUser: async () => refusal,
};

async function call(toolName: string, input?: unknown, workspaceId: string = WS) {
  const response = await callPersonTool(deps, { userId: USER, workspaceId, via: "cli", toolName, bodyText: input === undefined ? "" : JSON.stringify(input) });
  return { status: response.status, body: (await response.json()) as { status?: string; output?: any; issues?: string[]; error?: string } };
}

describe("person tool endpoint: skills", () => {
  beforeEach(() => {
    refusal = null;
    rows = [];
    insertError = null;
    nextId = 1;
  });

  it("list returns zero skills for an empty workspace", async () => {
    const result = await call("skills.list");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", output: { skills: [] } });
  });

  it("add creates a skill from explicit fields", async () => {
    const { body } = await call("skills.add", { name: "email-template", description: "when to use", content: "body" });
    expect(body.status).toBe("ok");
    expect(body.output.name).toBe("email-template");
    expect(body.output.content).toBe("body");
  });

  it("add requires a name and a description, and refuses input without them as invalid", async () => {
    for (const input of [{ content: "body" }, { name: "x", content: "body" }, { description: "d", content: "body" }]) {
      const result = await call("skills.add", input);
      expect(result.status).toBe(400);
      expect(result.body.status).toBe("invalid");
    }
    expect(rows).toHaveLength(0);
  });

  it("explicit fields override the content's own frontmatter", async () => {
    const content = "---\nname: frontmatter-name\ndescription: frontmatter-desc\nlicense: MIT\n---\nbody";
    const { body } = await call("skills.add", { name: "explicit-name", description: "explicit desc", content });
    expect(body.output.name).toBe("explicit-name");
    expect(body.output.description).toBe("explicit desc");
    expect(body.output.license).toBe("MIT");
  });

  it("answers with an error code for each way an add can be refused", async () => {
    expect((await call("skills.add", { name: "ok-name", description: "d", content: "---\nname: [unterminated\n---\nbody" })).body.output).toEqual({ error: "malformed_frontmatter" });
    expect((await call("skills.add", { name: "Bad_Name", description: "d", content: "c" })).body.output).toEqual({ error: "invalid_name" });
    expect((await call("skills.add", { name: "big", description: "d", content: "x".repeat(100 * 1024 + 1) })).body.output).toEqual({ error: "content_too_large" });
    insertError = { code: "23505", message: "duplicate key" };
    expect((await call("skills.add", { name: "dup", description: "d", content: "c" })).body.output).toEqual({ error: "duplicate_name" });
  });

  it("read answers skill_not_found for an unknown skill", async () => {
    expect((await call("skills.read", { name: "nope" })).body.output).toEqual({ error: "skill_not_found" });
  });

  it("update replaces content and sets updated_by, then delete soft-removes it", async () => {
    await call("skills.add", { name: "s", description: "d", content: "v1" });

    const updated = (await call("skills.update", { name: "s", description: "d2", content: "v2" })).body.output;
    expect(updated.content).toBe("v2");
    expect(updated.updatedBy).toBe(USER);

    expect((await call("skills.delete", { name: "s" })).body.output).toEqual({ ok: true });
    expect((await call("skills.read", { name: "s" })).body.output).toEqual({ error: "skill_not_found" });
  });

  it("update requires a description too", async () => {
    const result = await call("skills.update", { name: "s", content: "v2" });
    expect(result.status).toBe(400);
    expect(result.body.status).toBe("invalid");
  });

  it("update and delete on an unknown name answer skill_not_found", async () => {
    expect((await call("skills.update", { name: "missing", description: "d", content: "x" })).body.output).toEqual({ error: "skill_not_found" });
    expect((await call("skills.delete", { name: "missing" })).body.output).toEqual({ error: "skill_not_found" });
  });

  it("returns the workspace check's own refusal without touching skills", async () => {
    refusal = { status: 403, body: { error: "forbidden" } };
    const result = await call("skills.list");
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "forbidden" });
  });
});

describe("person tool endpoint: the call itself", () => {
  beforeEach(() => {
    refusal = null;
    rows = [];
  });

  it("answers 400 for a body that is not JSON, and for input that does not fit the tool", async () => {
    const response = await callPersonTool(deps, { userId: USER, workspaceId: WS, via: "cli", toolName: "skills.list", bodyText: "{nope" });
    expect(response.status).toBe(400);
    const invalid = await call("skills.read", { name: 5 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.status).toBe("invalid");
  });

  it("answers 403 for an unknown tool, as for a run, and 404 for a workspace id that is not an id", async () => {
    expect((await call("skills.nope")).status).toBe(403);
    expect((await call("skills.list", undefined, "ws-1")).status).toBe(404);
  });

  it("refuses a tool only a run may call", async () => {
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "x" }] });
    expect(result.status).toBe(403);
    expect(result.body.status).toBe("denied");
  });

  it("lists the tools a person may call, each with an input schema, and none that are run-only", async () => {
    const { tools } = (await listPersonTools(deps).json()) as { tools: Array<{ name: string; inputSchema: { type: string } }> };
    const names = tools.map((tool) => tool.name);
    for (const name of ["context.read", "context.list", "context.export", "sources.search", "sources.read", "skills.list", "skills.read", "skills.add", "skills.update", "skills.delete", "routines.list"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("context.write");
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });
});

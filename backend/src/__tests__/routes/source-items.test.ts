import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface SourceConnection {
  id: string;
  workspace_id: string;
  provider: string;
  connection_key: string;
}

interface SourceItem {
  id: string;
  workspace_id: string;
  source_connection_id: string;
  external_id: string;
  external_version: string;
  content_hash: string;
  content_markdown: string;
}

const state: { connections: SourceConnection[]; items: SourceItem[] } = { connections: [], items: [] };
let nextId = 0;
let itemUpsertShouldFail: string | null = null; // external_id to fail on

function createFakeClient() {
  return {
    from(table: string) {
      let operation: "select" | "upsert" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};

      function matches(row: object) {
        return Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
      }

      const execute = async () => {
        if (table === "source_connections") {
          if (operation === "upsert") {
            const existing = state.connections.find((row) => row.workspace_id === payload.workspace_id && row.provider === payload.provider);
            if (existing) {
              Object.assign(existing, payload);
              return { data: { ...existing }, error: null };
            }
            const row = { ...(payload as unknown as SourceConnection), id: `connection-${++nextId}` };
            state.connections.push(row);
            return { data: { ...row }, error: null };
          }
        }
        if (table === "source_items") {
          if (operation === "select") {
            // Prior-ready-revisions lookup inside upsertSourceItem — none in these tests.
            return { data: [], error: null };
          }
          if (operation === "upsert") {
            const externalId = payload.external_id as string;
            if (itemUpsertShouldFail === externalId) {
              return { data: null, error: new Error("simulated db failure") };
            }
            const row = { ...(payload as unknown as SourceItem), id: `item-${++nextId}` };
            state.items.push(row);
            return { data: { ...row }, error: null };
          }
          if (operation === "update") {
            return { data: null, error: null };
          }
        }
        throw new Error(`Unexpected fake query: ${operation} ${table}`);
      };

      const builder: Record<string, any> = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters[column] = value; return builder; },
        neq() { return builder; },
        upsert(nextPayload: Record<string, unknown>) { operation = "upsert"; payload = nextPayload; return builder; },
        update(nextPayload: Record<string, unknown>) { operation = "update"; payload = nextPayload; return builder; },
        in() { return builder; },
        async single() {
          const result = await execute();
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

let accessResult: Response | null = null;

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));

const routeModule = await import("../../routes/source-items");

beforeEach(() => {
  accessResult = null;
  state.connections = [];
  state.items = [];
  itemUpsertShouldFail = null;
});

function request(body?: unknown): Request {
  return Object.assign(
    new Request("https://internal.test", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: { id: workspaceId } },
  );
}

describe("POST /workspaces/:id/source-items", () => {
  it("uploads eligible files against a singleton manual_upload connection", async () => {
    const response = await routeModule.POST(
      request({ files: [{ path: "notes/one.md", content: "hello world" }] }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 1, skipped: [] });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.provider).toBe("manual_upload");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.external_id).toBe("notes/one.md");
    expect(state.items[0]?.content_markdown).toBe("hello world");
    expect(state.items[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-uploading reuses the same manual_upload connection instead of creating a second one", async () => {
    await routeModule.POST(request({ files: [{ path: "a.md", content: "one" }] }) as never);
    await routeModule.POST(request({ files: [{ path: "b.md", content: "two" }] }) as never);

    expect(state.connections).toHaveLength(1);
    expect(state.items).toHaveLength(2);
  });

  it("skips a single file over the per-file byte cap without failing the batch", async () => {
    const response = await routeModule.POST(
      request({ files: [
        { path: "big.md", content: "x".repeat(1_000_001) },
        { path: "small.md", content: "ok" },
      ] }) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; inserted: number; skipped: string[] };
    expect(body.ok).toBe(true);
    expect(body.inserted).toBe(1);
    expect(body.skipped).toEqual(["big.md"]);
    expect(state.items.map((item) => item.external_id)).toEqual(["small.md"]);
  });

  it("rejects the whole batch when total bytes exceed the cap", async () => {
    // Each file is under the per-file cap on its own; only the sum exceeds
    // the total cap, so this exercises the batch-level check specifically.
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `file-${i}.md`, content: "x".repeat(950_000) }));
    const response = await routeModule.POST(request({ files }) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "batch_too_large" });
    expect(state.connections).toHaveLength(0);
  });

  it("reports per-file upsert failures as skipped rather than failing the whole batch", async () => {
    itemUpsertShouldFail = "notes/one.md";

    const response = await routeModule.POST(
      request({ files: [{ path: "notes/one.md", content: "hello" }] }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 0, skipped: ["notes/one.md"] });
  });

  it("rejects a malformed body", async () => {
    const response = await routeModule.POST(request({ files: [{ path: "" }] }) as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_body" });
  });

  it("returns the workspace access denial before touching storage", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });

    const response = await routeModule.POST(
      request({ files: [{ path: "notes/one.md", content: "hello" }] }) as never,
    );

    expect(response.status).toBe(403);
    expect(state.connections).toHaveLength(0);
  });
});

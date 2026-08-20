import { beforeEach, describe, expect, it, mock } from "bun:test";
import { RunNotAllowedError } from "../../synthesis/check-run-allowed";
import { WorkspaceRunAlreadyActiveError } from "../../synthesis/prepare-run";

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
            // Post-RPC fetch-by-id inside upsertSourceItem.
            const found = state.items.find((item) => matches(item));
            return { data: found ?? null, error: found ? null : new Error("not found") };
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
    async rpc(fnName: string, params: Record<string, unknown>) {
      if (fnName !== "upsert_source_item") {
        throw new Error(`Unexpected rpc: ${fnName}`);
      }
      const externalId = params.p_external_id as string;
      if (itemUpsertShouldFail === externalId) {
        return { data: null, error: new Error("simulated db failure") };
      }
      const row: SourceItem = {
        id: `item-${++nextId}`,
        workspace_id: params.p_workspace_id as string,
        source_connection_id: params.p_source_connection_id as string,
        external_id: externalId,
        external_version: params.p_external_version as string,
        content_hash: params.p_content_hash as string,
        content_markdown: params.p_content_markdown as string,
      };
      state.items.push(row);
      return {
        data: { item_id: row.id, changed: true, superseded_item_ids: [] },
        error: null,
      };
    },
  };
}

let accessResult: Response | null = null;
type LaunchOutcome = { ok: true; runId: string; machineId: string } | { ok: false; error: Error };
let launchOutcome: LaunchOutcome = { ok: true, runId: "run-1", machineId: "machine-1" };
let launchCalls: Array<{ workspaceId: string; sourceItemIds: string[] }> = [];

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));
process.env.DRAFT_API_BASE_URL = "https://example.test";
process.env.FLY_API_TOKEN = "token";
process.env.FLY_APP_NAME = "app";
process.env.FLY_SANDBOX_IMAGE = `registry.fly.io/app@sha256:${"0".repeat(64)}`;
process.env.FLY_REGION = "ewr";
process.env.SANDBOX_CALLBACK_SECRET = "secret";
process.env.SUPABASE_URL = "https://project.supabase.co";
mock.module("../../synthesis/orchestrate-run", () => ({
  launchSynthesisRun: async (options: { workspaceId: string; sourceItemIds: string[] }) => {
    launchCalls.push({ workspaceId: options.workspaceId, sourceItemIds: options.sourceItemIds });
    if (launchOutcome.ok) return { runId: launchOutcome.runId, machineId: launchOutcome.machineId, bundleHash: "hash" };
    throw launchOutcome.error;
  },
}));

const routeModule = await import("../../routes/source-items");

beforeEach(() => {
  accessResult = null;
  state.connections = [];
  state.items = [];
  itemUpsertShouldFail = null;
  launchOutcome = { ok: true, runId: "run-1", machineId: "machine-1" };
  launchCalls = [];
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
        { path: "big.md", content: "x".repeat(5_000_001) },
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
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `file-${i}.md`, content: "x".repeat(4_750_000) }));
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

  it("triggerSynthesis: launches a run scoped to exactly the just-inserted item ids", async () => {
    const response = await routeModule.POST(
      request({ files: [{ path: "a.md", content: "one" }, { path: "b.md", content: "two" }], triggerSynthesis: true }) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; inserted: number; runId?: string; machineId?: string };
    expect(body).toMatchObject({ ok: true, inserted: 2, runId: "run-1", machineId: "machine-1" });
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.workspaceId).toBe(workspaceId);
    expect(launchCalls[0]?.sourceItemIds).toEqual(state.items.map((item) => item.id));
  });

  it("triggerSynthesis: does not launch when nothing was inserted", async () => {
    itemUpsertShouldFail = "a.md";

    const response = await routeModule.POST(
      request({ files: [{ path: "a.md", content: "one" }], triggerSynthesis: true }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 0, skipped: ["a.md"], reason: "no_ready_items" });
    expect(launchCalls).toHaveLength(0);
  });

  it("triggerSynthesis: reports a launch failure without masking the upload success", async () => {
    launchOutcome = { ok: false, error: new WorkspaceRunAlreadyActiveError(workspaceId) };

    const response = await routeModule.POST(
      request({ files: [{ path: "a.md", content: "one" }], triggerSynthesis: true }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 1, skipped: [], synthesisError: "run_already_active" });
  });

  it("triggerSynthesis: maps RunNotAllowedError and generic launch failures to distinct error codes", async () => {
    launchOutcome = { ok: false, error: new RunNotAllowedError(workspaceId, "runs_enabled is false") };
    let response = await routeModule.POST(request({ files: [{ path: "a.md", content: "one" }], triggerSynthesis: true }) as never);
    expect((await response.json() as { synthesisError: string }).synthesisError).toBe("run_not_allowed");

    launchOutcome = { ok: false, error: new Error("boom") };
    response = await routeModule.POST(request({ files: [{ path: "b.md", content: "two" }], triggerSynthesis: true }) as never);
    expect((await response.json() as { synthesisError: string }).synthesisError).toBe("launch_failed");
  });

  it("does not trigger synthesis when triggerSynthesis is omitted", async () => {
    const response = await routeModule.POST(request({ files: [{ path: "a.md", content: "one" }] }) as never);
    expect(await response.json()).toEqual({ ok: true, inserted: 1, skipped: [] });
    expect(launchCalls).toHaveLength(0);
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

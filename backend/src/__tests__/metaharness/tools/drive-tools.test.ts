import { beforeEach, describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.INFERENCE_CREDENTIAL_KEK_V1 ??= Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { parseUserId, parseWorkspaceId } = await import("draft-core/run-spec");
const { personCaller } = await import("draft-core/tools");
const { encryptCredentialPayload, CURRENT_CREDENTIAL_KEY_VERSION } = await import("../../../credentials/crypto");
const { createDriveTools, resetDriveLiveFetchLimit, changeSummary } = await import("../../../metaharness/tools/definitions/drive");
const { toolConnectionProviders, toolConnectionProvidersOrNone } = await import("../../../ingestion/gmail/access");
const { filterByConnections } = await import("../../../metaharness/tools/tool-registry");
const { invokeTool } = await import("../../../metaharness/tools/invoke-tool");
const { ToolRegistry } = await import("../../../metaharness/tools/tool-registry");
const { fakeClient, fakeDb, failingOn } = await import("../../routines/fake-client");

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "44444444-4444-4444-8444-444444444444";
const ASKER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const settings = { clientId: "c", clientSecret: "s", redirectUri: "https://api.test/cb" };
const DOC_MIME = "application/vnd.google-apps.document";

type Row = Record<string, unknown>;

const credential = (id: string) => ({
  id, workspace_id: WS, provider: "google", status: "active", expires_at: null,
  encrypted_payload: encryptCredentialPayload(JSON.stringify({ refresh_token: `refresh-${id}`, scopes: [] }), CURRENT_CREDENTIAL_KEY_VERSION),
  encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
});

const version = (id: string, created_at: string, content: string, lifecycle_status = "superseded", external_version = `v-${id}`): Row => ({
  id, workspace_id: WS, connection_id: "conn-owner", external_id: "file-1", external_version, created_at, lifecycle_status,
  visibility: "shared", content_markdown: content, metadata_json: { title: "Plan", folder_path: "Team/Plans", last_modified_by: "Ada" },
});

function seed(options: { lastSuccessAt?: string; askerHasDrive?: boolean; versions?: Row[] } = {}) {
  const connections: Row[] = [{
    id: "conn-owner", workspace_id: WS, provider: "google_drive", connected_by_user_id: OWNER, credential_id: "cred-owner",
    status: "active", last_success_at: options.lastSuccessAt ?? NOW.toISOString(), last_error_at: null,
  }];
  if (options.askerHasDrive ?? true) {
    connections.push({ id: "conn-asker", workspace_id: WS, provider: "google_drive", connected_by_user_id: ASKER, credential_id: "cred-asker", status: "active", last_success_at: NOW.toISOString(), last_error_at: null });
  }
  const source_items = options.versions ?? [
    version("v1", "2026-11-01T00:00:00.000Z", "# Plan\nship in May"),
    version("v2", "2026-11-10T00:00:00.000Z", "# Plan\nship in June", "active"),
  ];
  const db = fakeDb({ connections, credentials: [credential("cred-owner"), credential("cred-asker")], source_items }, {
    rpcs: {
      write_drive_source_item: (args: Record<string, unknown>) => {
        for (const row of db.tables.source_items!) if (row.external_id === args.p_external_id) row.lifecycle_status = "superseded";
        db.tables.source_items!.push({
          id: `v${db.tables.source_items!.length + 1}`, workspace_id: WS, connection_id: args.p_connection_id, external_id: args.p_external_id,
          external_version: args.p_external_version, created_at: NOW.toISOString(), lifecycle_status: "active", visibility: "shared",
          content_markdown: args.p_content_markdown, metadata_json: args.p_metadata_json, owner_user_id: args.p_owner_user_id,
        });
        return { data: { item_id: "new", changed: true }, error: null };
      },
      search_drive_items: (args: Record<string, unknown>) => {
        const rows = db.tables.source_items!
          .filter((row) => row.lifecycle_status === "active" || (args.p_include_history && row.lifecycle_status === "superseded"))
          .filter((row) => !args.p_query || String(row.content_markdown).includes(String(args.p_query)))
          .map((row, index) => ({ id: row.id, external_id: row.external_id, title: "Plan", occurred_at: row.created_at, created_at: row.created_at, lifecycle_status: row.lifecycle_status, rank: 1 - index / 10, snippet: "…" }))
          .filter((row) => args.p_after_rank === null || row.rank < (args.p_after_rank as number));
        return { data: rows.slice(0, args.p_limit as number), error: null };
      },
    },
  });
  return db;
}

function driveFetch(text: string, urls: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "access", expires_in: 3600 });
    if (url.pathname.endsWith("/comments")) return Response.json({ comments: [] });
    if (url.host === "docs.googleapis.com") return Response.json({ title: "Plan", body: { content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] } });
    return Response.json({ id: "file-1", name: "Plan", mimeType: DOC_MIME, modifiedTime: NOW.toISOString() });
  }) as unknown as typeof fetch;
}

function setup(db = seed(), fetchFn = driveFetch("live text")) {
  const registry = new ToolRegistry(createDriveTools(fakeClient(db), { fetch: fetchFn, settings: () => settings, now: () => NOW }));
  const deps = { registry, audit: async () => {}, authorizeUser: async () => null };
  const call = async (tool: string, args: unknown, userId = ASKER) => {
    const result = await invokeTool(deps, personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" }), tool, args);
    return result as { status: string; output?: Record<string, any>; error?: { code: string } } & Record<string, any>;
  };
  return { db, call };
}

const codeOf = (result: Record<string, any>) => result.code ?? result.error?.code ?? result.output?.code;

beforeEach(() => resetDriveLiveFetchLimit());

describe("drive.read", () => {
  it("refuses version with as_of, and as_of before the first capture", async () => {
    const { call } = setup();
    const both = await call("drive.read", { file_id: "file-1", version: "v1", as_of: "2026-11-05T00:00:00Z" });
    expect(both.status).not.toBe("ok");
    expect(codeOf(both)).toBe("invalid_input");
    const early = await call("drive.read", { file_id: "file-1", as_of: "2026-10-01T00:00:00Z" });
    expect(codeOf(early)).toBe("drive_no_version_at_time");
  });

  it("reads a fresh latest copy without fetching, and lists versions with change summaries", async () => {
    const urls: string[] = [];
    const { call } = setup(seed(), driveFetch("live", urls));
    const result = await call("drive.read", { file_id: "file-1", include: ["versions"] });
    expect(result.status).toBe("ok");
    expect(urls).toEqual([]);
    expect(result.output).toMatchObject({ version_count: 2, version_id: "v2", source: "stored", content: "# Plan\nship in June", is_latest: true });
    expect(result.output!.versions.map((entry: Row) => [entry.version_id, entry.change_summary])).toEqual([["v2", "ship in June"], ["v1", null]]);
  });

  it("treats a reverted version (A then B then A) as the latest, ordered by when it became current", async () => {
    const reverted = { ...version("v1", "2026-11-01T00:00:00.000Z", "# Plan\nA", "active"), normalized_at: "2026-11-15T00:00:00.000Z" };
    const middle = { ...version("v2", "2026-11-10T00:00:00.000Z", "# Plan\nB"), normalized_at: "2026-11-10T00:00:00.000Z" };
    const { call } = setup(seed({ versions: [reverted, middle] }));
    const latest = await call("drive.read", { file_id: "file-1" });
    expect(latest.output).toMatchObject({ version_id: "v1", is_latest: true, version_count: 2, content: "# Plan\nA", captured_at: "2026-11-15T00:00:00.000Z", last_captured_at: "2026-11-15T00:00:00.000Z" });
    expect((await call("drive.read", { file_id: "file-1", as_of: "2026-11-12T00:00:00Z" })).output).toMatchObject({ version_id: "v2", is_latest: false });
    expect((await call("drive.read", { file_id: "file-1", as_of: "2026-11-16T00:00:00+00:00" })).output).toMatchObject({ version_id: "v1", is_latest: true });
  });

  it("reads by as_of and by version", async () => {
    const { call } = setup();
    expect((await call("drive.read", { file_id: "file-1", as_of: "2026-11-05T00:00:00Z" })).output).toMatchObject({ version_id: "v1", is_latest: false });
    expect((await call("drive.read", { file_id: "file-1", version: "v1" })).output!.content).toBe("# Plan\nship in May");
  });

  it("fetches a stale copy and stores it under the owning connection", async () => {
    const db = seed({ lastSuccessAt: "2026-11-20T11:00:00.000Z" });
    const { call } = setup(db);
    const result = await call("drive.read", { file_id: "file-1" });
    expect(result.output).toMatchObject({ source: "live", version_count: 3 });
    expect(result.output!.content).toContain("live text");
    const write = db.rpcCalls.find((entry) => entry.name === "write_drive_source_item")!;
    expect(write.args).toMatchObject({ p_connection_id: "conn-owner", p_owner_user_id: OWNER, p_visibility: "shared" });
    expect((write.args.p_metadata_json as Row).folder_path).toBe("Team/Plans");
  });

  it("gives the stored copy marked stale to an asker without a Drive login", async () => {
    const urls: string[] = [];
    const { call } = setup(seed({ lastSuccessAt: "2026-11-20T11:00:00.000Z", askerHasDrive: false }), driveFetch("live", urls));
    const result = await call("drive.read", { file_id: "file-1" });
    expect(result.output).toMatchObject({ source: "stored", stale: true, version_id: "v2" });
    expect(urls).toEqual([]);
  });

  it("caps live fetches at 10 per user per minute", async () => {
    const urls: string[] = [];
    const db = seed({ lastSuccessAt: "2026-11-20T11:00:00.000Z" });
    const { call } = setup(db, driveFetch("# Plan\nship in June", urls));
    for (let index = 0; index < 10; index++) await call("drive.read", { file_id: "file-1" });
    const fetched = urls.filter((url) => url.includes("oauth2")).length;
    const capped = await call("drive.read", { file_id: "file-1" });
    expect(urls.filter((url) => url.includes("oauth2")).length).toBe(fetched);
    expect(capped.output).toMatchObject({ stale: true });
  });

  it("pages content and versions with a cursor bound to the version", async () => {
    const versions = Array.from({ length: 55 }, (_, index) =>
      version(`v${index}`, new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(), index === 54 ? "x".repeat(3000) : `line ${index}`, index === 54 ? "active" : "superseded"));
    const { call } = setup(seed({ versions }));
    const first = await call("drive.read", { file_id: "file-1", max_bytes: 1024, include: ["versions"] });
    expect(first.output).toMatchObject({ truncated: true, version_id: "v54" });
    expect(first.output!.versions).toHaveLength(50);
    const second = await call("drive.read", { file_id: "file-1", max_bytes: 4096, include: ["versions"], cursor: first.output!.next_cursor });
    expect(second.output!.content).toHaveLength(1976);
    expect(second.output!.versions).toHaveLength(5);
    expect(second.output!.next_cursor).toBeNull();
    expect(codeOf(await call("drive.read", { file_id: "other", cursor: first.output!.next_cursor }))).toBe("invalid_cursor");
  });
});

describe("drive.search", () => {
  it("finds old phrases only with include_history and names each version", async () => {
    const { call } = setup();
    expect((await call("drive.search", { query: "May" })).output!.results).toEqual([]);
    const history = await call("drive.search", { query: "May", include_history: true });
    expect(history.output!.results).toEqual([expect.objectContaining({ file_id: "file-1", version_id: "v1", is_latest: false })]);
  });

  it("pages with a cursor tied to the same search", async () => {
    const { call } = setup();
    const first = await call("drive.search", { query: "ship", include_history: true, limit: 1 });
    expect(first.output!.results).toHaveLength(1);
    const second = await call("drive.search", { query: "ship", include_history: true, limit: 1, cursor: first.output!.next_cursor });
    expect(second.output!.results).toHaveLength(1);
    expect(second.output!.next_cursor).toBeNull();
    expect(codeOf(await call("drive.search", { query: "other", cursor: first.output!.next_cursor }))).toBe("invalid_cursor");
  });
});

describe("Drive tool visibility", () => {
  const tools = createDriveTools(fakeClient(fakeDb({})));

  it("lists the tools when anyone in the workspace has a live Drive connection", async () => {
    const providers = await toolConnectionProviders(fakeClient(seed({ askerHasDrive: false })), WS, ASKER);
    expect(providers.has("google_drive")).toBe(false);
    expect(filterByConnections(tools, providers).map((tool) => tool.name)).toEqual(["drive.read", "drive.search"]);
  });

  it("hides them with no Drive connection or a failed lookup", async () => {
    const none = await toolConnectionProviders(fakeClient(fakeDb({ connections: [] })), WS, ASKER);
    expect(filterByConnections(tools, none)).toEqual([]);
    const failed = await toolConnectionProvidersOrNone(failingOn(fakeClient(seed()), "connections"), WS, ASKER, "test");
    expect(filterByConnections(tools, failed)).toEqual([]);
  });

  it("summarizes the first changed line", () => {
    expect(changeSummary("a\nb", "a\nc")).toBe("c");
    expect(changeSummary("a\nb", "a")).toBe("b");
    expect(changeSummary("a", `a\n${"z".repeat(200)}`)).toHaveLength(120);
  });
});

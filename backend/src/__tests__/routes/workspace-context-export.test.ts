import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as queryLog from "../../observability/record-query-log";
import { strFromU8, unzipSync } from "fflate";

const caller = { userId: "33333333-3333-4333-8333-333333333333", accessToken: "token-1" };
const secret = "route-test-secret";
process.env.CONTEXT_EXPORT_SECRET = secret;
process.env.DRAFT_API_BASE_URL = "https://api.test";
let accessResult: Response | null = null;
let queryResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let logged: Array<Record<string, unknown>> = [];

const version = {
  id: "version-1",
  version_number: 3,
  content_hash: "hash",
  creation_reason: "synthesis",
  created_at: "2026-10-05T00:00:00Z",
  documents_json: { "memory/2026-10.md": { content: "remember", sha256: "x".repeat(64) } },
};

function queryBuilder(table: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => {
      if (table === "users") return { data: { primary_team_id: "team-1" }, error: null };
      if (table === "workspaces") return { data: { id: "22222222-2222-4222-8222-222222222222" }, error: null };
      return queryResult;
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
mock.module("../../db/client", () => ({ serviceClient: { from: (table: string) => queryBuilder(table) } }));
const queryLogSpy = spyOn(queryLog, "recordAgentQueryLog").mockImplementation(
  async (_client: unknown, input: queryLog.RecordAgentQueryLogInput) => {
    logged.push({ ...input });
  },
);
afterAll(() => queryLogSpy.mockRestore());

let hiddenPaths: string[] = [];
mock.module("../../metaharness/context/visible-context", () => ({
  visibleContext: (_caller: unknown, documents: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(documents).filter(([path]) => !hiddenPaths.includes(path))),
  canSeeContextPath: () => true,
}));

const routes = await import("../../routes/workspace-context-export");
const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { buildMcpServer } = await import("../../mcp/tools");
const { verifyContextExportToken } = await import("../../context-export/token");

function request(params: Record<string, string>, headers: Record<string, string> = {}): never {
  return Object.assign(new Request("http://internal.test", { headers }), { params }) as never;
}

async function mintLink(): Promise<string> {
  const { createContextExportLink } = await import("../../context-export/link");
  const result = await createContextExportLink("22222222-2222-4222-8222-222222222222", caller.userId, undefined, { from: (table: string) => queryBuilder(table) } as never);
  if (!result.ok) throw new Error("no link");
  return result.link.url.split("/context-exports/")[1]!;
}

describe("context export routes", () => {
  beforeEach(() => {
    accessResult = null;
    queryResult = { data: version, error: null };
    logged = [];
  });

  it("still logs a redeemed link, which is how an agent downloads one", async () => {
    const token = await mintLink();
    await routes.redeemGET(request({ token }, { "x-draft-client": "desktop" }));
    await Promise.resolve();
    expect(logged[0]).toMatchObject({ command: "context.export", argsJson: { via: "link" } });
  });

  it("answers 404 for a link when there is no context yet, and 403 when access was lost", async () => {
    const token = await mintLink();
    queryResult = { data: null, error: null };
    expect((await routes.redeemGET(request({ token }))).status).toBe(404);
    queryResult = { data: version, error: null };
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await routes.redeemGET(request({ token }))).status).toBe(403);
  });

  it("builds the zip from what visibleContext lets that person see", async () => {
    const token = await mintLink();
    queryResult = {
      data: { ...version, documents_json: { ...version.documents_json, "private/notes.md": { content: "secret", sha256: "y".repeat(64) } } },
      error: null,
    };
    hiddenPaths = ["private/notes.md"];
    const entries = unzipSync(new Uint8Array(await (await routes.redeemGET(request({ token }))).arrayBuffer()));
    expect(Object.keys(entries).some((name) => name.endsWith("private/notes.md"))).toBe(false);
    expect(strFromU8(entries["draft-context/memory/2026-10.md"]!)).toBe("remember");
    hiddenPaths = [];
  });

  it("mints a link that redeems to a no-store zip", async () => {
    const token = await mintLink();
    const response = await routes.redeemGET(request({ token }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await Promise.resolve();
    expect(logged[0]).toMatchObject({ command: "context.export", argsJson: { via: "link", versionNumber: 3 } });
  });

  it("rejects a tampered token", async () => {
    const token = await mintLink();
    expect((await routes.redeemGET(request({ token: `${token}x` }))).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const token = await mintLink();
      Date.now = () => realNow() + 12 * 60 * 1000;
      expect((await routes.redeemGET(request({ token }))).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  it("kills the link when the user loses access", async () => {
    const token = await mintLink();
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await routes.redeemGET(request({ token }))).status).toBe(403);
    expect(logged).toHaveLength(0);
  });
});

async function callMcpExport(scopes: string[]) {
  const handler = createMcpHandler(() => buildMcpServer("33333333-3333-4333-8333-333333333333", scopes));
  const response = await handler.fetch(
    new Request("http://internal.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "context.export", arguments: {} },
      }),
    }),
  );
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }> };
}

describe("mcp context.export", () => {
  beforeEach(() => {
    accessResult = null;
    queryResult = { data: version, error: null };
    logged = [];
  });

  it("returns a link that downloads a valid zip with a read-only token", async () => {
    const result = await callMcpExport(["read"]);
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]!.text) as { url: string; fileName: string; instructions: string };
    expect(body.fileName).toContain("draft-context-v3-");
    expect(body.instructions).toContain("curl -L");
    expect(body.url.startsWith("https://api.test/context-exports/")).toBe(true);

    const token = body.url.split("/context-exports/")[1]!;
    expect(verifyContextExportToken(token, secret)).toMatchObject({ workspaceId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333" });
    const response = await routes.redeemGET(request({ token }));
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(strFromU8(entries["draft-context/memory/2026-10.md"]!)).toBe("remember");
  });

  it("logs mcp.context.export", async () => {
    await callMcpExport(["read"]);
    await Promise.resolve();
    expect(logged[0]).toMatchObject({ command: "mcp.context.export" });
  });

  it("reports no_context_yet", async () => {
    queryResult = { data: null, error: null };
    const result = await callMcpExport(["read"]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "no_context_yet", message: expect.stringContaining("no context yet") });
  });
});

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { strFromU8, unzipSync } from "fflate";

const caller = { userId: "user-1", accessToken: "token-1" };
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
      if (table === "workspaces") return { data: { id: "ws-1" }, error: null };
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
mock.module("../../observability/record-query-log", () => ({
  recordAgentQueryLog: async (_client: unknown, input: Record<string, unknown>) => {
    logged.push(input);
  },
}));

const routes = await import("../../routes/workspace-context-export");
const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { buildMcpServer } = await import("../../mcp/tools");
const { verifyContextExportToken } = await import("../../context-export/token");

function request(params: Record<string, string>): never {
  return Object.assign(new Request("http://internal.test"), { params }) as never;
}

async function mintLink(): Promise<string> {
  const response = await routes.exportLinkPOST(request({ id: "ws-1" }));
  const body = (await response.json()) as { url: string };
  return body.url.split("/context-exports/")[1]!;
}

describe("context export routes", () => {
  beforeEach(() => {
    accessResult = null;
    queryResult = { data: version, error: null };
    logged = [];
  });

  it("returns an authenticated zip with a log row", async () => {
    const response = await routes.exportGET(request({ id: "ws-1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("draft-context-v3-");
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(strFromU8(entries["draft-context/memory/2026-10.md"]!)).toBe("remember");
    await Promise.resolve();
    expect(logged[0]).toMatchObject({ command: "context.export", workspaceId: "ws-1" });
  });

  it("denies a forbidden workspace", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await routes.exportGET(request({ id: "ws-1" }))).status).toBe(403);
    expect((await routes.exportLinkPOST(request({ id: "ws-1" }))).status).toBe(403);
  });

  it("returns 404 when there is no context yet", async () => {
    queryResult = { data: null, error: null };
    expect((await routes.exportGET(request({ id: "ws-1" }))).status).toBe(404);
    expect((await routes.exportLinkPOST(request({ id: "ws-1" }))).status).toBe(404);
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
  const handler = createMcpHandler(() => buildMcpServer("user-1", scopes));
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
    expect(verifyContextExportToken(token, secret)).toMatchObject({ workspaceId: "ws-1", userId: "user-1" });
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
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "no_context_yet" });
  });
});

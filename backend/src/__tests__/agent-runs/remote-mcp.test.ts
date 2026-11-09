import { describe, expect, it } from "bun:test";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseSourceConnectionId,
  parseUserId,
  parseWorkspaceId,
  type AgentRunSpec,
} from "draft-core/agent-run";
import { invokeTool, type ToolCallRecord } from "../../agent-runs/invoke-tool";
import {
  assertSafeMcpUrl,
  createMcpConnection,
  remoteToolName,
  remoteToolsForRun,
  usableMcpConnections,
  type ConnectRemoteMcp,
  type RemoteMcpSession,
} from "../../agent-runs/remote-mcp";
import { ToolRegistry } from "../../agent-runs/tool-registry";
import { fakeClient, fakeDb } from "../routines/fake-client";

process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER_PERSON = "77777777-7777-4777-8777-777777777777";
const TOKEN = "super-secret-remote-token";
const URL_A = "https://tools.example.com/mcp";

const tools = [
  { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
];

interface FakeRemote {
  connect: ConnectRemoteMcp;
  connects: Array<{ url: string; token: string }>;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  reply: { content?: unknown; isError?: boolean };
  closed: number;
}

function fakeRemote(overrides: { tools?: typeof tools; failConnect?: boolean } = {}): FakeRemote {
  const state: FakeRemote = {
    connects: [],
    calls: [],
    reply: { content: [{ type: "text", text: "3 issues found" }] },
    closed: 0,
    connect: async (url, token) => {
      state.connects.push({ url, token });
      if (overrides.failConnect) throw new Error("connection refused");
      const session: RemoteMcpSession = {
        listTools: async () => ({ tools: overrides.tools ?? tools }),
        callTool: async (request) => {
          state.calls.push(request);
          return state.reply;
        },
        close: async () => {
          state.closed += 1;
        },
      };
      return session;
    },
  };
  return state;
}

function newDb() {
  return fakeDb({ credentials: [], source_connections: [] });
}

let nextId = 0;

async function connect(db: ReturnType<typeof newDb>, remote: FakeRemote, overrides: { userId?: string | null; displayName?: string; url?: string } = {}) {
  const created = await createMcpConnection(
    fakeClient(db),
    { workspaceId: WS, userId: overrides.userId === undefined ? OWNER : overrides.userId, url: overrides.url ?? URL_A, token: TOKEN, displayName: overrides.displayName ?? "Linear" },
    { connect: remote.connect },
  );
  // The fake database does not make UUIDs, and a run's environment needs one.
  const connectionId = `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  db.tables.source_connections!.find((row) => row.id === created.connectionId)!.id = connectionId;
  return { ...created, connectionId };
}

function runWith(connectionId: string, toolsAllowed: "all" | string[] = "all"): AgentRunSpec {
  return {
    id: parseAgentRunId("22222222-2222-4222-8222-222222222222"),
    kind: "routine",
    workspaceId: parseWorkspaceId(WS),
    trigger: { type: "manual", requestedBy: parseUserId(OWNER) },
    principal: { type: "workspace" },
    runtime: { type: "cloud", environment: { nativeTools: [], mcpServers: [{ connectionId: parseSourceConnectionId(connectionId), tools: toolsAllowed }], skills: [], instructions: [] } },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId("44444444-4444-4444-8444-444444444444") },
    permissions: [],
    output: { type: "text" },
  };
}

describe("assertSafeMcpUrl", () => {
  it("accepts an HTTPS server on the public internet", () => {
    expect(assertSafeMcpUrl("https://mcp.linear.app/mcp")).toBe("https://mcp.linear.app/mcp");
  });

  it("refuses anything that could reach Draft's own network", () => {
    for (const bad of [
      "http://tools.example.com/mcp",
      "https://localhost/mcp",
      "https://db.internal/mcp",
      "https://printer.local/mcp",
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://192.168.0.5/mcp",
      "https://172.20.0.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
      "https://user:pw@tools.example.com/mcp",
    ]) {
      expect(() => assertSafeMcpUrl(bad)).toThrow();
    }
  });

  it("lets a local address through only when asked, for tests and development", () => {
    expect(assertSafeMcpUrl("http://localhost:8787/mcp", { allowLocal: true })).toBe("http://localhost:8787/mcp");
  });
});

describe("createMcpConnection", () => {
  it("checks the server, keeps the token only as an encrypted credential, and caches the tool list", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId, tools: listed } = await connect(db, remote);

    expect(remote.connects).toEqual([{ url: URL_A, token: TOKEN }]);
    expect(listed.map((tool) => tool.name)).toEqual(["search_issues", "create_issue"]);
    expect(remote.closed).toBe(1);

    const credential = db.tables.credentials![0]!;
    expect(credential).toMatchObject({ workspace_id: WS, provider: "mcp", label: "Linear", created_by_user_id: OWNER });
    expect(JSON.stringify(credential)).not.toContain(TOKEN);

    const connection = db.tables.source_connections![0]!;
    expect(connection).toMatchObject({ id: connectionId, provider: "mcp", connection_key: URL_A, display_name: "Linear", status: "active", credential_id: credential.id, connected_by_user_id: OWNER });
    expect((connection.config_json as { tools: unknown[] }).tools).toHaveLength(2);
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
  });

  it("stores nothing when the server does not answer", async () => {
    const db = newDb();
    await expect(connect(db, fakeRemote({ failConnect: true }))).rejects.toThrow("connection refused");
    expect(db.tables.credentials).toHaveLength(0);
    expect(db.tables.source_connections).toHaveLength(0);
  });

  it("stores nothing for an address it will not call", async () => {
    const db = newDb();
    const remote = fakeRemote();
    await expect(connect(db, remote, { url: "https://10.0.0.1/mcp" })).rejects.toThrow("public internet");
    expect(remote.connects).toHaveLength(0);
  });
});

describe("usableMcpConnections", () => {
  it("lets a person use their own and shared connections, and no one else's or a revoked one", async () => {
    const db = newDb();
    const own = await connect(db, fakeRemote(), { userId: OWNER, displayName: "Mine", url: "https://a.example.com/mcp" });
    const shared = await connect(db, fakeRemote(), { userId: null, displayName: "Shared", url: "https://b.example.com/mcp" });
    const theirs = await connect(db, fakeRemote(), { userId: OTHER_PERSON, displayName: "Theirs", url: "https://c.example.com/mcp" });
    const revoked = await connect(db, fakeRemote(), { userId: OWNER, displayName: "Revoked", url: "https://d.example.com/mcp" });
    db.tables.source_connections!.find((row) => row.id === revoked.connectionId)!.status = "revoked";

    const usable = await usableMcpConnections(fakeClient(db), WS, OWNER, [own.connectionId, shared.connectionId, theirs.connectionId, revoked.connectionId]);
    expect(usable.map((row) => row.display_name).sort()).toEqual(["Mine", "Shared"]);
  });

  it("returns nothing for no ids", async () => {
    expect(await usableMcpConnections(fakeClient(newDb()), WS, OWNER, [])).toEqual([]);
  });
});

describe("remoteToolsForRun", () => {
  it("offers each of the server's tools under a name that carries the connection", async () => {
    const db = newDb();
    const { connectionId } = await connect(db, fakeRemote());
    const offered = await remoteToolsForRun(fakeClient(db), runWith(connectionId));
    expect(offered.map((tool) => tool.name)).toEqual([remoteToolName("linear", "search_issues"), remoteToolName("linear", "create_issue")]);
    expect(offered[0]).toMatchObject({ name: "mcp.linear.search_issues", callers: ["run"], access: "write" });
    expect(offered[0]!.description).toContain("[Linear]");
  });

  it("offers only the tools the person allowed", async () => {
    const db = newDb();
    const { connectionId } = await connect(db, fakeRemote());
    const offered = await remoteToolsForRun(fakeClient(db), runWith(connectionId, ["search_issues"]));
    expect(offered.map((tool) => tool.name)).toEqual(["mcp.linear.search_issues"]);
  });

  it("offers nothing for a run with no environment connections, a local run, or a revoked connection", async () => {
    const db = newDb();
    const { connectionId } = await connect(db, fakeRemote());
    const none = runWith(connectionId);
    if (none.runtime.type !== "cloud") throw new Error("unreachable");
    expect(await remoteToolsForRun(fakeClient(db), { ...none, runtime: { ...none.runtime, environment: { ...none.runtime.environment, mcpServers: [] } } })).toEqual([]);
    expect(await remoteToolsForRun(fakeClient(db), { ...none, runtime: { type: "local", hostMachineId: "mac" as never } })).toEqual([]);
    db.tables.source_connections![0]!.status = "revoked";
    expect(await remoteToolsForRun(fakeClient(db), runWith(connectionId))).toEqual([]);
  });

  it("keeps two servers with the same name apart and skips names too long for an agent to use", async () => {
    const db = newDb();
    const first = await connect(db, fakeRemote(), { displayName: "Linear", url: "https://a.example.com/mcp" });
    const second = await connect(db, fakeRemote({ tools: [{ ...tools[0]!, name: "x".repeat(31) }, tools[0]!] }), { displayName: "Linear", url: "https://b.example.com/mcp" });
    const run = runWith(first.connectionId);
    if (run.runtime.type !== "cloud") throw new Error("unreachable");
    const both = { ...run, runtime: { ...run.runtime, environment: { ...run.runtime.environment, mcpServers: [...run.runtime.environment.mcpServers, { connectionId: parseSourceConnectionId(second.connectionId), tools: "all" as const }] } } };
    const names = (await remoteToolsForRun(fakeClient(db), both)).map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name.includes("x".repeat(31)))).toBe(false);
    expect(names.filter((name) => name.endsWith(".search_issues"))).toHaveLength(2);
  });

  it("calls the remote server with the stored token, and the agent only ever sees the reply", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId } = await connect(db, remote);
    remote.connects.length = 0;
    const run = runWith(connectionId);
    const registry = new ToolRegistry(await remoteToolsForRun(fakeClient(db), run, { connect: remote.connect }));
    const audits: ToolCallRecord[] = [];

    const result = await invokeTool({ registry, audit: async (record) => void audits.push(record) }, { type: "run", run }, "mcp.linear.search_issues", { query: "bug" });

    expect(result).toEqual({ status: "ok", output: "3 issues found" });
    expect(remote.connects).toEqual([{ url: URL_A, token: TOKEN }]);
    expect(remote.calls).toEqual([{ name: "search_issues", arguments: { query: "bug" } }]);
    expect(remote.closed).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(audits[0]).toMatchObject({ toolName: "mcp.linear.search_issues", status: "ok", arguments: { server: "Linear", tool: "search_issues" } });
    expect(JSON.stringify(audits[0]!.arguments)).not.toContain("bug");
  });

  it("checks the arguments against the server's own schema before calling it", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId } = await connect(db, remote);
    const run = runWith(connectionId);
    const registry = new ToolRegistry(await remoteToolsForRun(fakeClient(db), run, { connect: remote.connect }));
    remote.calls.length = 0;
    const result = await invokeTool({ registry, audit: async () => undefined }, { type: "run", run }, "mcp.linear.search_issues", { query: 5 });
    expect(result.status).toBe("invalid");
    expect(remote.calls).toEqual([]);
  });

  it("shows the agent a remote tool's own error, and no other internal error", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId } = await connect(db, remote);
    const run = runWith(connectionId);
    const registry = new ToolRegistry(await remoteToolsForRun(fakeClient(db), run, { connect: remote.connect }));
    const call = () => invokeTool({ registry, audit: async () => undefined }, { type: "run", run }, "mcp.linear.search_issues", { query: "bug" });

    remote.reply = { isError: true, content: [{ type: "text", text: "rate limited, try later" }] };
    expect(await call()).toEqual({ status: "error", message: "rate limited, try later" });

    db.tables.credentials![0]!.status = "revoked";
    const failed = await call();
    expect(failed).toMatchObject({ status: "error", message: "The tool failed. Try again, or report the problem." });
  });

  it("passes on a reply that is not plain text as JSON", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId } = await connect(db, remote);
    const run = runWith(connectionId);
    const registry = new ToolRegistry(await remoteToolsForRun(fakeClient(db), run, { connect: remote.connect }));
    remote.reply = { content: [{ type: "image", data: "abc", mimeType: "image/png" }] };
    const result = await invokeTool({ registry, audit: async () => undefined }, { type: "run", run }, "mcp.linear.search_issues", { query: "x" });
    expect(result).toMatchObject({ status: "ok" });
    expect(JSON.parse((result as { output: string }).output)).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
  });

  it("is refused to a run whose environment does not name it", async () => {
    const db = newDb();
    const remote = fakeRemote();
    const { connectionId } = await connect(db, remote);
    const named = runWith(connectionId);
    const registry = new ToolRegistry(await remoteToolsForRun(fakeClient(db), named, { connect: remote.connect }));
    const stranger = runWith("99999999-9999-4999-8999-999999999999");
    const result = await invokeTool({ registry, audit: async () => undefined }, { type: "run", run: stranger }, "mcp.linear.search_issues", { query: "x" });
    expect(result).toMatchObject({ status: "denied", code: "not_permitted" });
  });
});

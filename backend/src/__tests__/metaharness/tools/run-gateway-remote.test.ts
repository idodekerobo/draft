import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseSourceConnectionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { createAgentRun } from "../../../metaharness/runs/agent-run-store";
import { createMcpConnection, remoteToolsForRun, type ConnectRemoteMcp } from "../../../metaharness/tools/remote-mcp";
import { createRunGateway } from "../../../metaharness/tools/run-gateway";
import { createAgentRunToken } from "../../../metaharness/runs/run-token";
import { createDraftToolRegistry } from "../../../metaharness/tools/definitions";
import { fakeClient, fakeDb } from "../../routines/fake-client";
import { createFakeContextDb } from "../context/fake-context-db";

process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const SECRET = "test-secret";
const WS = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "00000000-0000-4000-8000-0000000000aa";
const TOKEN = "remote-secret-token";

const searchTool = { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };

async function setup(options: { named?: boolean } = {}) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const connect: ConnectRemoteMcp = async () => ({
    listTools: async () => ({ tools: [searchTool] }),
    callTool: async (request) => {
      calls.push(request);
      return { content: [{ type: "text", text: "3 issues found" }] };
    },
    close: async () => undefined,
  });

  const connectionsDb = fakeDb({ credentials: [], source_connections: [] });
  const created = await createMcpConnection(fakeClient(connectionsDb), { workspaceId: WS, userId: OWNER, url: "https://tools.example.com/mcp", token: TOKEN, displayName: "Linear" }, { connect });
  connectionsDb.tables.source_connections!.find((row) => row.id === created.connectionId)!.id = CONNECTION_ID;

  const db = createFakeContextDb({ "a.md": "A" });
  const spec: AgentRunSpec = {
    id: parseAgentRunId(RUN_ID),
    kind: "routine",
    workspaceId: parseWorkspaceId(WS),
    trigger: { type: "manual", requestedBy: parseUserId(OWNER) },
    actor: { type: "agent", runId: parseAgentRunId(RUN_ID) }, onBehalfOf: null,
    runtime: {
      type: "cloud",
      environment: { nativeTools: [], mcpServers: options.named === false ? [] : [{ connectionId: parseSourceConnectionId(CONNECTION_ID), tools: "all" }], skills: [], instructions: [] },
    },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(db.pointer()!) },
    permissions: [{ tool: "context.read" }],
    output: { type: "text" },
  };
  await createAgentRun(db.client, { spec, idempotencyKey: "k", status: "running" });

  const gateway = createRunGateway({
    client: db.client,
    secret: () => SECRET,
    registry: createDraftToolRegistry(db.client),
    remoteTools: (run) => remoteToolsForRun(fakeClient(connectionsDb), run, { connect }),
  });
  const token = createAgentRunToken({ runId: parseAgentRunId(RUN_ID), workspaceId: parseWorkspaceId(WS), expiresAt: Date.now() + 60_000, nonce: "n" }, SECRET);
  const request = (path: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, gateway, request, calls };
}

async function mcp(gateway: Awaited<ReturnType<typeof setup>>["gateway"], request: Request) {
  const text = await (await gateway.mcp(request, RUN_ID)).text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: { required?: string[] } }> };
}

describe("a run's remote tools through the gateway", () => {
  it("lists them next to Draft's own, with the server's argument schema", async () => {
    const { gateway, request } = await setup();
    const body = (await (await gateway.listTools(request("/x"), RUN_ID)).json()) as { tools: Array<{ name: string; access: string; inputSchema: { required?: string[] } }> };
    expect(body.tools.map((tool) => tool.name).sort()).toEqual(["context.read", "mcp.linear.search_issues"]);
    const remote = body.tools.find((tool) => tool.name === "mcp.linear.search_issues")!;
    expect(remote.access).toBe("write");
    expect(remote.inputSchema.required).toEqual(["query"]);
  });

  it("calls one over HTTP, writes the audit row, and never returns the token", async () => {
    const { gateway, request, calls, db } = await setup();
    const response = await gateway.callTool(request("/x", { query: "bug" }), RUN_ID, "mcp.linear.search_issues");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ status: "ok", output: "3 issues found" });
    expect(text).not.toContain(TOKEN);
    expect(calls).toEqual([{ name: "search_issues", arguments: { query: "bug" } }]);
    expect(db.toolCalls).toContainEqual({ tool_name: "mcp.linear.search_issues", status: "ok", agent_run_id: RUN_ID });
  });

  it("offers them over MCP, with the schema, and answers a call with the reply as plain text", async () => {
    const { gateway, request } = await setup();
    const list = await mcp(gateway, request("/x", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const remote = list.tools!.find((tool) => tool.name === "mcp.linear.search_issues")!;
    expect(remote.inputSchema.required).toEqual(["query"]);

    const call = await mcp(gateway, request("/x", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp.linear.search_issues", arguments: { query: "bug" } } }));
    expect(call.content[0]!.text).toBe("3 issues found");
    expect(call.isError).toBeUndefined();
  });

  it("does not offer or run them for a run whose environment names no connection", async () => {
    const { gateway, request, calls } = await setup({ named: false });
    const body = (await (await gateway.listTools(request("/x"), RUN_ID)).json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((tool) => tool.name)).toEqual(["context.read"]);
    const response = await gateway.callTool(request("/x", { query: "bug" }), RUN_ID, "mcp.linear.search_issues");
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

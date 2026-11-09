import { describe, expect, it } from "bun:test";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseHostMachineId,
  parseUserId,
  parseWorkspaceId,
  type AgentRunSpec,
  type AnyDraftToolPermission,
} from "draft-core/agent-run";
import { createAgentRun } from "../../agent-runs/agent-run-store";
import { createRunGateway } from "../../agent-runs/run-gateway";
import { createAgentRunToken } from "../../agent-runs/run-token";
import { createFakeContextDb } from "./fake-context-db";
import { createDraftToolRegistry } from "../../agent-runs/tools";

const SECRET = "test-secret";
const WS = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const FAR_FUTURE = Date.now() + 60_000;

async function setup(permissions: AnyDraftToolPermission[], status = "running") {
  const db = createFakeContextDb({ "a.md": "A" });
  const spec: AgentRunSpec = {
    id: parseAgentRunId(RUN_ID),
    kind: "routine",
    workspaceId: parseWorkspaceId(WS),
    trigger: { type: "manual", requestedBy: parseUserId("33333333-3333-4333-8333-333333333333") },
    principal: { type: "workspace" },
    runtime: { type: "local", hostMachineId: parseHostMachineId("mac") },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(db.pointer()!) },
    permissions,
    output: { type: "text" },
  };
  await createAgentRun(db.client, { spec, idempotencyKey: "k", status: status as never });
  const gateway = createRunGateway({ client: db.client, secret: () => SECRET, registry: createDraftToolRegistry(db.client) });
  const token = (overrides: Partial<{ runId: string; workspaceId: string; expiresAt: number }> = {}) =>
    createAgentRunToken(
      {
        runId: parseAgentRunId(overrides.runId ?? RUN_ID),
        workspaceId: parseWorkspaceId(overrides.workspaceId ?? WS),
        expiresAt: overrides.expiresAt ?? FAR_FUTURE,
        nonce: "n",
      },
      SECRET,
    );
  const request = (path: string, init: { token?: string | null; method?: string; body?: unknown } = {}) =>
    new Request(`http://localhost${path}`, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token()}` }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return { db, gateway, token, request };
}

describe("run gateway authentication", () => {
  it("rejects a missing token, a bad token and a token for another run", async () => {
    const { gateway, request, token } = await setup([{ tool: "context.read" }]);
    expect((await gateway.listTools(request("/x", { method: "GET", token: null }), RUN_ID)).status).toBe(401);
    expect((await gateway.listTools(request("/x", { method: "GET", token: "junk.token" }), RUN_ID)).status).toBe(401);
    const otherRun = token({ runId: "99999999-9999-4999-8999-999999999999" });
    expect((await gateway.listTools(request("/x", { method: "GET", token: otherRun }), RUN_ID)).status).toBe(401);
  });

  it("rejects an expired token and a token naming another workspace", async () => {
    const { gateway, request, token } = await setup([{ tool: "context.read" }]);
    expect((await gateway.listTools(request("/x", { method: "GET", token: token({ expiresAt: 1 }) }), RUN_ID)).status).toBe(401);
    expect((await gateway.listTools(request("/x", { method: "GET", token: token({ workspaceId: "88888888-8888-4888-8888-888888888888" }) }), RUN_ID)).status).toBe(401);
  });

  it("rejects the token of a run that has finished", async () => {
    const { gateway, request } = await setup([{ tool: "context.read" }], "succeeded");
    expect((await gateway.listTools(request("/x", { method: "GET" }), RUN_ID)).status).toBe(401);
  });
});

describe("run gateway HTTP tools", () => {
  it("lists only the tools the run was given, with schemas", async () => {
    const { gateway, request } = await setup([{ tool: "context.read" }]);
    const body = (await (await gateway.listTools(request("/x", { method: "GET" }), RUN_ID)).json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(body.tools.map((tool) => tool.name)).toEqual(["context.read"]);
    expect(body.tools[0].inputSchema).toMatchObject({ type: "object" });
  });

  it("calls a permitted tool and writes an audit row", async () => {
    const { gateway, request, db } = await setup([{ tool: "context.read" }]);
    const response = await gateway.callTool(request("/x", { body: { paths: ["a.md"] } }), RUN_ID, "context.read");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { output: { documents: Array<{ content: string }> } }).output.documents[0].content).toBe("A");
    expect(db.toolCalls).toEqual([{ tool_name: "context.read", status: "ok", agent_run_id: RUN_ID }]);
  });

  it("answers 403 for a tool the run was not given and 400 for bad input", async () => {
    const { gateway, request, token } = await setup([{ tool: "context.read" }]);
    expect((await gateway.callTool(request("/x", { body: {} }), RUN_ID, "context.write")).status).toBe(403);
    expect((await gateway.callTool(request("/x", { body: { paths: 5 } }), RUN_ID, "context.read")).status).toBe(400);
    const notJson = new Request("http://localhost/x", { method: "POST", headers: { authorization: `Bearer ${token()}` }, body: "{not json" });
    expect((await gateway.callTool(notJson, RUN_ID, "context.read")).status).toBe(400);
  });

  it("returns a write conflict as a normal answer the agent can act on", async () => {
    const { gateway, request, db } = await setup([{ tool: "context.write" }]);
    db.writeBehindTheScenes({ "a.md": "theirs" });
    const response = await gateway.callTool(request("/x", { body: { summary: "s", changes: [{ path: "a.md", content: "mine" }] } }), RUN_ID, "context.write");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "conflict", output: { retryable: true } });
  });
});

function mcpCall(gateway: ReturnType<typeof createRunGateway>, request: Request) {
  return gateway.mcp(request, RUN_ID);
}

async function readJsonRpc(response: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await response.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))!.slice(5).trim()
    : text;
  return JSON.parse(data);
}

describe("run gateway MCP", () => {
  it("requires the run token", async () => {
    const { gateway, request } = await setup([{ tool: "context.read" }]);
    const response = await mcpCall(gateway, request("/x", { token: null, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }));
    expect(response.status).toBe(401);
  });

  it("lists only permitted tools and runs a call through the same gateway", async () => {
    const { gateway, request, db } = await setup([{ tool: "context.read" }]);
    const list = await readJsonRpc(await mcpCall(gateway, request("/x", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })));
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["context.read"]);

    const call = await readJsonRpc(
      await mcpCall(gateway, request("/x", { body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context.read", arguments: { paths: ["a.md"] } } } })),
    );
    const content = (call.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(content).documents[0].content).toBe("A");
    expect(db.toolCalls.at(-1)).toMatchObject({ tool_name: "context.read", status: "ok" });
  });

  it("does not expose a tool the run was not given", async () => {
    const { gateway, request, db } = await setup([{ tool: "context.read" }]);
    const call = await readJsonRpc(
      await mcpCall(gateway, request("/x", { body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context.write", arguments: { summary: "s", changes: [{ path: "a.md", content: "x" }] } } } })),
    );
    expect(JSON.stringify(call)).toMatch(/not found|unknown|invalid|error/i);
    expect(db.current()["a.md"].content).toBe("A");
  });
});

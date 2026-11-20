import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthorizationDenial, ToolCallRecord } from "../../metaharness/tools/invoke-tool";
import { createDraftToolRegistry } from "../../metaharness/tools/definitions";
import { registerGatewayTools, type McpGateway } from "../../mcp/gateway-tools";
import { createFakeContextDb } from "../metaharness/context/fake-context-db";
import { sha256 } from "../../synthesis/context-version-files";

const schedules = await import("../../routines/service");
const agentStatus = await import("../../routines/agent-status");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

// The routine store is not part of these tests: the gateway's routine tools are checked up to the save.
const createRoutine = spyOn(schedules, "createAgentRoutine").mockImplementation(async (_workspaceId, _creator, input) =>
  ({ id: "task-new", kind: "in" in input.when || "at" in input.when ? "once" : "recurring", title: input.config.title }) as never,
);
const listRoutines = spyOn(schedules, "listRoutines").mockResolvedValue([]);
const agentProblem = spyOn(agentStatus, "routineAgentProblem").mockResolvedValue(null);
afterAll(() => {
  createRoutine.mockRestore();
  listRoutines.mockRestore();
  agentProblem.mockRestore();
});

let workspaceId: string | null = WORKSPACE_ID;
let refusal: AuthorizationDenial | null = null;
const audits: ToolCallRecord[] = [];

function gateway(): McpGateway {
  const db = createFakeContextDb({ "product/index.md": "# Product", "memory/days/2026-11-09.md": "today" });
  return {
    resolveWorkspaceId: async () => workspaceId,
    deps: {
      registry: createDraftToolRegistry(db.client),
      audit: async (record) => void audits.push(record),
      authorizeUser: async () => refusal,
    },
  };
}

async function rpc(method: string, params: Record<string, unknown> = {}, scopes: string[] = []) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "draft", version: "1.0.0" });
    registerGatewayTools(server, USER_ID, gateway(), scopes);
    return server;
  });
  const response = await handler.fetch(
    new Request("http://internal.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }>; tools?: Array<{ name: string }> };
}

const call = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
/** A call on a connection with write access, as a person approves at sign-in. */
const writeCall = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args }, ["write"]);

describe("MCP tools that go through the gateway", () => {
  beforeEach(() => {
    workspaceId = WORKSPACE_ID;
    refusal = null;
    audits.length = 0;
  });

  it("marks reads as read-only and a delete as destructive, so a client can ask before it", async () => {
    const result = await rpc("tools/list");
    const tool = (name: string) => (result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>).find((item) => item.name === name)!;
    expect(tool("routines.list").annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool("routines.delete").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool("skills.delete").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool("skills.update").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("registers the tools that run through the gateway, and no run-only tool or tool that needs a connection the caller lacks", async () => {
    const result = await rpc("tools/list");
    const names = result.tools!.map((tool) => tool.name).sort();
    expect(names).toEqual(["activity.list", "connections.connect", "connections.disconnect", "connections.join", "connections.leave", "connections.list", "connections.post", "connections.read", "connections.search", "context.export", "context.list", "context.read", "people.approve", "people.create", "people.find", "people.notify", "people.reject", "people.update", "routines.create", "routines.delete", "routines.list", "routines.options", "routines.run", "routines.runs", "routines.update", "sessions.list", "sessions.read", "skills.add", "skills.delete", "skills.list", "skills.read", "skills.update", "sources.list", "sources.read", "sources.search"]);
  });

  it("context.read returns the shape clients already read, and audits it as an MCP call by this person", async () => {
    const result = await call("context.read", { dimensions: ["memory"] });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ versionNumber: 1, documents: [{ path: "memory/days/2026-11-09.md", content: "today", sha256: sha256("today") }] });
    expect(Object.keys(body).sort()).toEqual(["contentHash", "createdAt", "creationReason", "documents", "versionId", "versionNumber"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      toolName: "context.read",
      status: "ok",
      caller: { origin: { kind: "person", userId: USER_ID, via: "mcp" }, workspaceId: WORKSPACE_ID },
      arguments: { dimensions: ["memory"] },
    });
    expect(audits[0]!.resultBytes).toBeGreaterThan(0);
  });

  it("records a write-scope refusal as one denied call without retaining the prompt", async () => {
    const result = await call("routines.create", { title: "Check PR", prompt: "private prompt", harness: "claude", when: { in: "2h" } });
    expect(result.isError).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ toolName: "routines.create", status: "denied", errorCode: "insufficient_scope", arguments: {} });
    expect(JSON.stringify(audits)).not.toContain("private prompt");
  });

  it("context.list lists the dimensions", async () => {
    const result = await call("context.list");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ dimensions: [{ name: "product", path: "product/index.md" }] });
  });

  it("answers no_workspace when the caller has none, without calling a tool", async () => {
    workspaceId = null;
    const result = await call("context.read");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("no_workspace");
    expect(audits).toHaveLength(0);
  });

  it("answers forbidden with the status when access is denied, and does not read", async () => {
    refusal = { status: 403, body: { error: "forbidden" } };
    const result = await call("context.read");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("forbidden (403)");
    expect(audits[0]).toMatchObject({ status: "denied", errorCode: "caller_not_authorized" });
  });

  it("sources.search refuses with the service's code, flags the call as failed, audits it as refused and redacts the cursor", async () => {
    const result = await call("sources.search", { query: " ", cursor: "opaque-cursor" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "invalid_query" });
    expect(audits[0]).toMatchObject({ toolName: "sources.search", status: "refused", errorCode: "invalid_query", arguments: { query: " ", cursor: "[redacted]" } });
    expect(JSON.stringify(audits[0])).not.toContain("opaque-cursor");
  });

  it("rejects input that does not match the tool's schema before anything runs", async () => {
    const result = await call("sources.read", { source_item_id: "not-a-uuid" });
    expect(result.isError).toBe(true);
    expect(audits).toHaveLength(0);
  });

  describe("routines with when", () => {
    const routine = { title: "Check PR", prompt: "Look at the PR and say what is left.", harness: "claude" };

    beforeEach(() => {
      createRoutine.mockClear();
      listRoutines.mockClear();
    });

    it("creates a one-shot from when.in, for this person, and answers with its kind", async () => {
      const result = await writeCall("routines.create", { ...routine, when: { in: "2h" } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ routine: { id: "task-new", kind: "once", title: "Check PR" } });
      expect(createRoutine).toHaveBeenCalledWith(
        WORKSPACE_ID,
        { userId: USER_ID, via: "mcp", runId: null, depth: 0, visibility: "shared" },
        expect.objectContaining({ when: { in: "2h" } }),
      );
    });

    it("refuses a time that has passed, with the code and message the client reads", async () => {
      const result = await writeCall("routines.create", { ...routine, when: { at: "2020-01-01T00:00:00.000Z" } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "in_the_past", message: "That time has already passed (2020-01-01T00:00:00.000Z). Use a future time." });
      expect(createRoutine).not.toHaveBeenCalled();
    });

    it("rejects the old schedule fields, which are not part of the input any more", async () => {
      const result = await writeCall("routines.create", { ...routine, schedule: { preset: "daily", time: "09:00" } });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Unrecognized key: "schedule"');
      expect(createRoutine).not.toHaveBeenCalled();
    });

    it("lists one-shots only when the call asks for them by kind", async () => {
      await call("routines.list", { kind: "once" });
      expect(listRoutines).toHaveBeenLastCalledWith(WORKSPACE_ID, USER_ID, { kind: "once" });
    });
  });
});

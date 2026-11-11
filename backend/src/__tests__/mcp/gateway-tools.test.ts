import { beforeEach, describe, expect, it } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthorizationDenial, ToolCallRecord } from "../../metaharness/tools/invoke-tool";
import { createDraftToolRegistry } from "../../metaharness/tools/definitions";
import { registerGatewayTools, type McpGateway } from "../../mcp/gateway-tools";
import { createFakeContextDb } from "../metaharness/context/fake-context-db";
import { sha256 } from "../../synthesis/context-version-files";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

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

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "draft", version: "1.0.0" });
    registerGatewayTools(server, USER_ID, gateway());
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

describe("MCP tools that go through the gateway", () => {
  beforeEach(() => {
    workspaceId = WORKSPACE_ID;
    refusal = null;
    audits.length = 0;
  });

  it("registers the tools that run through the gateway, and no run-only tool", async () => {
    const result = await rpc("tools/list");
    const names = result.tools!.map((tool) => tool.name).sort();
    expect(names).toEqual(["context.export", "context.list", "context.read", "people.add_identity", "people.approve", "people.create", "people.find", "people.notify", "people.reject", "routines.list", "skills.add", "skills.list", "skills.read", "sources.read", "sources.search"]);
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
      caller: { type: "user", userId: USER_ID, workspaceId: WORKSPACE_ID, via: "mcp" },
      arguments: { dimensions: ["memory"] },
    });
    expect(audits[0]!.resultBytes).toBeGreaterThan(0);
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
});

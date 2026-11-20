import { describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";

const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { buildMcpServer } = await import("../../mcp/tools");
const { createDraftToolRegistry } = await import("../../metaharness/tools/definitions");
const { createFakeContextDb } = await import("../metaharness/context/fake-context-db");
import type { McpGateway } from "../../mcp/gateway-tools";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const TEAMMATE_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function gateway(connectionProviders?: McpGateway["connectionProviders"]): McpGateway {
  const db = createFakeContextDb({ "product/index.md": "# Product" });
  return {
    resolveWorkspaceId: async () => WORKSPACE_ID,
    connectionProviders,
    deps: { registry: createDraftToolRegistry(db.client), audit: async () => {}, authorizeUser: async () => null },
  };
}

async function listedTools(override: McpGateway): Promise<string[]> {
  const handler = createMcpHandler(() => buildMcpServer(USER_ID, ["read"], override));
  const response = await handler.fetch(new Request("http://internal.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }));
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return (JSON.parse(dataLine ? dataLine.slice(5) : text).result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

const gmailTools = (names: string[]) => names.filter((name) => name.startsWith("gmail.")).sort();

describe("MCP Gmail tools", () => {
  it("lists them for a caller with their own Gmail connection", async () => {
    expect(gmailTools(await listedTools(gateway(async () => new Set(["gmail"]))))).toEqual(["gmail.attachment", "gmail.read", "gmail.search"]);
  });

  it("hides them when only a teammate connected Gmail", async () => {
    const byUser = async (_workspaceId: string, userId: string) => new Set(userId === TEAMMATE_ID ? ["gmail"] : []);
    const names = await listedTools(gateway(byUser));
    expect(gmailTools(names)).toEqual([]);
    expect(names).toContain("context.read");
  });

  it("hides them when the lookup fails or is not given", async () => {
    expect(gmailTools(await listedTools(gateway(async () => { throw new Error("db down"); })))).toEqual([]);
    expect(gmailTools(await listedTools(gateway()))).toEqual([]);
  });
});

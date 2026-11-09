import type { SupabaseClient } from "@supabase/supabase-js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRunSpec } from "draft-core/agent-run";
import { auditToDatabase, loadActiveAgentRunSpec } from "./agent-run-store";
import { invokeTool, type InvokeToolDeps, type InvokeToolResult } from "./invoke-tool";
import { toMcpResult } from "./mcp-result";
import { AgentRunTokenError, verifyAgentRunToken } from "./run-token";
import type { ToolRegistry } from "./tool-registry";

export interface RunGatewayDeps {
  client: SupabaseClient;
  /** Reads the signing secret when a request arrives, so a missing setting fails the request and not startup. */
  secret: () => string;
  registry: ToolRegistry;
  now?: () => number;
}

type Authenticated = { ok: true; run: AgentRunSpec } | { ok: false; response: Response };

const unauthorized = (): Authenticated => ({ ok: false, response: new Response(null, { status: 401 }) });

function statusFor(result: InvokeToolResult): number {
  switch (result.status) {
    case "ok":
    case "conflict":
      return 200;
    case "denied":
      return 403;
    case "invalid":
      return 400;
    case "error":
      return 500;
  }
}

/**
 * The run-scoped edge. A run proves itself with its token, and the gateway builds the ToolCaller.
 * Everything after that is invokeTool, the same for the MCP route and the HTTP route.
 */
export function createRunGateway(deps: RunGatewayDeps) {
  const invokeDeps: InvokeToolDeps = { registry: deps.registry, audit: auditToDatabase(deps.client), now: deps.now };

  async function authenticate(request: Request, runId: string): Promise<Authenticated> {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return unauthorized();
    try {
      const claims = verifyAgentRunToken(header.slice("Bearer ".length), deps.secret(), { now: deps.now?.() });
      if (claims.runId !== runId) return unauthorized();
      const run = await loadActiveAgentRunSpec(deps.client, runId);
      if (!run || run.workspaceId !== claims.workspaceId) return unauthorized();
      return { ok: true, run };
    } catch (error) {
      if (error instanceof AgentRunTokenError) return unauthorized();
      throw error;
    }
  }

  async function listTools(request: Request, runId: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const tools = deps.registry.listFor(auth.run).map((tool) => ({
      name: tool.name,
      access: tool.access,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    }));
    return Response.json({ tools });
  }

  async function callTool(request: Request, runId: string, toolName: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    let args: unknown = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        args = JSON.parse(text);
      } catch {
        return Response.json({ status: "invalid", issues: ["body is not valid JSON"] }, { status: 400 });
      }
    }
    const result = await invokeTool(invokeDeps, { type: "run", run: auth.run }, toolName, args);
    return Response.json(result, { status: statusFor(result) });
  }

  async function mcp(request: Request, runId: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const run = auth.run;
    // Stateless, like the person-facing MCP: a fresh server per request that lists only this run's tools.
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "draft", version: "1.0.0" });
      for (const tool of deps.registry.listFor(run)) {
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema as z.ZodObject },
          async (args: unknown) => toMcpResult(await invokeTool(invokeDeps, { type: "run", run }, tool.name, args)),
        );
      }
      return server;
    });
    return handler.fetch(request);
  }

  return { listTools, callTool, mcp };
}

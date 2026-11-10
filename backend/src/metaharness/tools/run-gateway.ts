import type { SupabaseClient } from "@supabase/supabase-js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRunSpec } from "draft-core/run-spec";
import { auditToDatabase, loadActiveAgentRunSpec } from "../runs/agent-run-store";
import { parseToolArgs, toHttpResponse } from "./http-result";
import { invokeTool, type InvokeToolDeps } from "./invoke-tool";
import { toMcpResult } from "./mcp-result";
import { remoteToolsForRun } from "./remote-mcp";
import { AgentRunTokenError, verifyAgentRunToken } from "../runs/run-token";
import { describeTools, type RegisteredTool, type ToolRegistry } from "./tool-registry";

export interface RunGatewayDeps {
  client: SupabaseClient;
  /** Reads the signing secret when a request arrives, so a missing setting fails the request and not startup. */
  secret: () => string;
  registry: ToolRegistry;
  /** The tools a run reaches through its connections. They are looked up for each request. */
  remoteTools?: (run: AgentRunSpec) => Promise<RegisteredTool[]>;
  now?: () => number;
}

type Authenticated = { ok: true; run: AgentRunSpec } | { ok: false; response: Response };

const unauthorized = (): Authenticated => ({ ok: false, response: new Response(null, { status: 401 }) });

/**
 * The run-scoped edge. A run proves itself with its token, and the gateway builds the ToolCaller.
 * Everything after that is invokeTool, the same for the MCP route and the HTTP route.
 */
export function createRunGateway(deps: RunGatewayDeps) {
  const audit = auditToDatabase(deps.client);
  const remoteTools = deps.remoteTools ?? ((run: AgentRunSpec) => remoteToolsForRun(deps.client, run));

  /** Draft's tools plus the ones this run reaches through its connections. */
  async function depsFor(run: AgentRunSpec): Promise<InvokeToolDeps> {
    const remote = await remoteTools(run);
    return { registry: remote.length > 0 ? deps.registry.extendedWith(remote) : deps.registry, audit, now: deps.now };
  }

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
    const tools = describeTools((await depsFor(auth.run)).registry.listFor(auth.run));
    return Response.json({ tools });
  }

  async function callTool(request: Request, runId: string, toolName: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const body = parseToolArgs(await request.text());
    if (!body.ok) return body.response;
    const result = await invokeTool(await depsFor(auth.run), { type: "run", run: auth.run }, toolName, body.args);
    return toHttpResponse(result);
  }

  async function mcp(request: Request, runId: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const run = auth.run;
    const requestDeps = await depsFor(run);
    // Stateless, like the person-facing MCP: a fresh server per request that lists only this run's tools.
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "draft", version: "1.0.0" });
      for (const tool of requestDeps.registry.listFor(run)) {
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema as z.ZodObject },
          async (args: unknown) => toMcpResult(await invokeTool(requestDeps, { type: "run", run }, tool.name, args)),
        );
      }
      return server;
    });
    return handler.fetch(request);
  }

  return { listTools, callTool, mcp };
}

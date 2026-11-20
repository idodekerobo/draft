import type { SupabaseClient } from "@supabase/supabase-js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, type ToolCaller } from "draft-core/tools";
import { auditToDatabase, loadActiveAgentRunSpec } from "../runs/agent-run-store";
import { parseToolArgs, toHttpResponse } from "./http-result";
import { invokeTool, type InvokeToolDeps } from "./invoke-tool";
import { toMcpResult } from "./mcp-result";
import { remoteToolsForRun } from "./remote-mcp";
import { AgentRunTokenError, verifyAgentRunToken } from "../runs/run-token";
import { describeTools, filterByConnections, type RegisteredTool, type ToolRegistry } from "./tool-registry";
import { toolConnectionProvidersOrNone } from "../../ingestion/gmail/access";
import { userInvokeDeps } from "./user-gateway";
import { recordError } from "../../errors/record-error";

export interface RunGatewayDeps {
  client: SupabaseClient;
  /** Reads the signing secret when a request arrives, so a missing setting fails the request and not startup. */
  secret: () => string;
  registry: ToolRegistry;
  /** The tools a run reaches through its connections. They are looked up for each request. */
  remoteTools?: (run: AgentRunSpec) => Promise<RegisteredTool[]>;
  /** The person's own live connection providers. Defaults to a lookup that fails closed. */
  connectionProviders?: (workspaceId: string, userId: string) => Promise<ReadonlySet<string>>;
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
  const connectionProviders = deps.connectionProviders
    ?? ((workspaceId: string, userId: string) => toolConnectionProvidersOrNone(deps.client, workspaceId, userId, "run_gateway"));

  /** Draft's tools plus the ones this run reaches through its connections. */
  async function depsFor(run: AgentRunSpec): Promise<InvokeToolDeps> {
    const remote = await remoteTools(run);
    return { registry: remote.length > 0 ? deps.registry.extendedWith(remote) : deps.registry, audit, now: deps.now };
  }

  /**
   * An interactive run that acts for a person is that person's own agent, as a local session is. It also gets
   * every tool the person can call over MCP, called as the person. Null for any other run.
   */
  async function personToolsFor(run: AgentRunSpec, runDeps: InvokeToolDeps): Promise<{ deps: InvokeToolDeps; caller: ToolCaller; tools: RegisteredTool[] } | null> {
    if (run.kind !== "interactive" || !run.onBehalfOf) return null;
    const runTools = new Set(runDeps.registry.listFor(run).map((tool) => tool.name));
    let providers: ReadonlySet<string>;
    try {
      providers = await connectionProviders(run.workspaceId, run.onBehalfOf);
    } catch (error) {
      await recordError({ client: deps.client, workspaceId: run.workspaceId, agentRunId: run.id, operation: "read", code: "tool_connections_lookup_failed", message: "Looking up the caller's connections failed, so connection-gated tools are hidden", detail: { surface: "run_gateway" }, error });
      providers = new Set();
    }
    return {
      deps: { ...userInvokeDeps(deps.client, deps.registry), now: deps.now },
      caller: personCaller({ userId: run.onBehalfOf, workspaceId: run.workspaceId, via: "mcp" }),
      tools: filterByConnections(deps.registry.listForUser(), providers).filter((tool) => tool.mcp && !runTools.has(tool.name)),
    };
  }

  async function authenticate(request: Request, runId: string): Promise<Authenticated> {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return unauthorized();
    try {
      const claims = verifyAgentRunToken(header.slice("Bearer ".length), deps.secret(), { now: deps.now?.() });
      if (claims.runId !== runId) return unauthorized();
      // A host token runs the session host, not the agent, so it is not a tool credential.
      if (claims.scope === "host") return { ok: false, response: Response.json({ ok: false, error: "token_scope" }, { status: 403 }) };
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
    const runDeps = await depsFor(auth.run);
    const person = await personToolsFor(auth.run, runDeps);
    const tools = describeTools([...runDeps.registry.listFor(auth.run), ...(person?.tools ?? [])]);
    return Response.json({ tools });
  }

  async function callTool(request: Request, runId: string, toolName: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const body = parseToolArgs(await request.text());
    if (!body.ok) return body.response;
    const runDeps = await depsFor(auth.run);
    const person = await personToolsFor(auth.run, runDeps);
    const result = person?.tools.some((tool) => tool.name === toolName)
      ? await invokeTool(person.deps, person.caller, toolName, body.args)
      : await invokeTool(runDeps, runCaller(auth.run), toolName, body.args);
    return toHttpResponse(result);
  }

  async function mcp(request: Request, runId: string): Promise<Response> {
    const auth = await authenticate(request, runId);
    if (!auth.ok) return auth.response;
    const run = auth.run;
    const requestDeps = await depsFor(run);
    const person = await personToolsFor(run, requestDeps);
    // Stateless, like the person-facing MCP: a fresh server per request that lists only this run's tools.
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "draft", version: "1.0.0" });
      for (const tool of requestDeps.registry.listFor(run)) {
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema as z.ZodObject },
          async (args: unknown) => toMcpResult(await invokeTool(requestDeps, runCaller(run), tool.name, args)),
        );
      }
      for (const tool of person?.tools ?? []) {
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.inputSchema as z.ZodObject },
          async (args: unknown) => toMcpResult(await invokeTool(person!.deps, person!.caller, tool.name, args)),
        );
      }
      return server;
    });
    return handler.fetch(request);
  }

  return { listTools, callTool, mcp };
}

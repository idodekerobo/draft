import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { parseUserId, parseWorkspaceId } from "draft-core/agent-run";
import { invokeTool, type InvokeToolDeps } from "../agent-runs/invoke-tool";
import { toMcpResult } from "../agent-runs/mcp-result";

/** What this surface needs from the gateway. Tests pass their own. */
export interface McpGateway {
  deps: InvokeToolDeps;
  resolveWorkspaceId: (userId: string) => Promise<string | null>;
}

/** The tools of this surface that already run through the gateway. */
export const MCP_GATEWAY_TOOLS = new Set(["context.list", "context.read", "context.export", "sources.search", "sources.read"]);

/**
 * These tools are defined once, in the gateway's registry. This surface only proves who the caller is,
 * finds their workspace and passes the call on; access, audit and what the caller may see are decided there.
 */
export function registerGatewayTools(server: McpServer, userId: string, gateway: McpGateway): void {
  for (const tool of gateway.deps.registry.listForUser().filter((candidate) => MCP_GATEWAY_TOOLS.has(candidate.name))) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema as z.ZodObject },
      async (args: unknown) => {
        const workspaceId = await gateway.resolveWorkspaceId(userId);
        if (!workspaceId) return { isError: true, content: [{ type: "text" as const, text: "no_workspace" }] };
        const result = await invokeTool(
          gateway.deps,
          { type: "user", userId: parseUserId(userId), workspaceId: parseWorkspaceId(workspaceId), via: "mcp" },
          tool.name,
          args,
        );
        return toMcpResult(result);
      },
    );
  }
}

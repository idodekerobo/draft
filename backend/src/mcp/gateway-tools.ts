import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { invokeTool, type InvokeToolDeps } from "../metaharness/tools/invoke-tool";
import { toMcpResult } from "../metaharness/tools/mcp-result";

/** What this surface needs from the gateway. Tests pass their own. */
export interface McpGateway {
  deps: InvokeToolDeps;
  resolveWorkspaceId: (userId: string) => Promise<string | null>;
}

const READ_ONLY_CONNECTION = "insufficient_scope: this connection only has read access. Re-authorize the Draft connection and approve write access.";

/**
 * These tools are defined once, in the gateway's registry. This surface only proves who the caller is,
 * finds their workspace and passes the call on; access, audit and what the caller may see are decided there.
 */
export function registerGatewayTools(server: McpServer, userId: string, gateway: McpGateway, scopes: string[] = []): void {
  for (const tool of gateway.deps.registry.listForUser().filter((candidate) => candidate.mcp)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as z.ZodObject,
        annotations: { readOnlyHint: tool.access === "read", destructiveHint: tool.destructive, openWorldHint: false },
      },
      async (args: unknown) => {
        const workspaceId = await gateway.resolveWorkspaceId(userId);
        if (!workspaceId) return { isError: true, content: [{ type: "text" as const, text: "no_workspace" }] };
        const caller = personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(workspaceId), via: "mcp" });
        if (tool.access === "write" && !scopes.includes("write")) {
          try {
            await gateway.deps.audit({ caller, toolName: tool.name, arguments: {}, status: "denied", resultBytes: 0,
              resultSummary: null, errorCode: "insufficient_scope", durationMs: 0 });
          } catch { console.error(JSON.stringify({ source: "mcp", event: "audit_failed", tool: tool.name })); }
          return { isError: true, content: [{ type: "text" as const, text: READ_ONLY_CONNECTION }] };
        }
        const result = await invokeTool(
          gateway.deps,
          caller,
          tool.name,
          args,
        );
        return toMcpResult(result);
      },
    );
  }
}

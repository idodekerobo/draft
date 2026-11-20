import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { invokeTool, type InvokeToolDeps } from "../metaharness/tools/invoke-tool";
import { toMcpResult } from "../metaharness/tools/mcp-result";
import { recordError } from "../errors/record-error";
import { filterByConnections } from "../metaharness/tools/tool-registry";

/** What this surface needs from the gateway. Tests pass their own. */
export interface McpGateway {
  deps: InvokeToolDeps;
  resolveWorkspaceId: (userId: string) => Promise<string | null>;
  /** The caller's providers from toolConnectionProviders. Left out, no connection-gated tool is offered. */
  connectionProviders?: (workspaceId: string, userId: string) => Promise<ReadonlySet<string>>;
}

const READ_ONLY_CONNECTION = "insufficient_scope: this connection only has read access. Re-authorize the Draft connection and approve write access.";

/**
 * These tools are defined once, in the gateway's registry. This surface only proves who the caller is,
 * finds their workspace and passes the call on; access, audit and what the caller may see are decided there.
 */
export function registerGatewayTools(server: McpServer, userId: string, gateway: McpGateway, scopes: string[] = [], providers: ReadonlySet<string> = new Set()): void {
  for (const tool of filterByConnections(gateway.deps.registry.listForUser(), providers).filter((candidate) => candidate.mcp)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as z.ZodObject,
        annotations: { readOnlyHint: tool.access === "read", destructiveHint: tool.destructive, openWorldHint: false },
      },
      async (args: unknown) => {
        const workspaceId = await gateway.resolveWorkspaceId(userId);
        if (!workspaceId) {
          await recordError({ workspaceId: null, allowUnattributed: true, operation: "auth", code: "mcp_workspace_unavailable", message: "MCP tool call could not resolve a workspace", detail: { tool: tool.name } });
          return { isError: true, content: [{ type: "text" as const, text: "no_workspace" }] };
        }
        const caller = personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(workspaceId), via: "mcp" });
        if (tool.access === "write" && !scopes.includes("write")) {
          try {
            await gateway.deps.audit({ caller, toolName: tool.name, arguments: {}, status: "denied", resultBytes: 0,
              resultSummary: null, errorCode: "insufficient_scope", durationMs: 0 });
          } catch { console.error(JSON.stringify({ source: "mcp", event: "audit_failed", tool: tool.name })); }
          await recordError({ workspaceId, operation: "auth", code: "insufficient_scope", message: "MCP write tool call was denied for insufficient scope", detail: { tool: tool.name } });
          return { isError: true, content: [{ type: "text" as const, text: READ_ONLY_CONNECTION }] };
        }
        const result = await invokeTool(
          gateway.deps,
          caller,
          tool.name,
          args,
        );
        if (result.status !== "ok" && result.status !== "conflict") {
          const code = "code" in result ? result.code : result.status === "invalid" ? "invalid_arguments" : "mcp_tool_failed";
          const message = "message" in result ? result.message : result.status === "invalid" ? result.issues.join("; ") : "MCP tool call failed";
          await recordError({ workspaceId, operation: "execution", code, message: `MCP ${tool.name} failed: ${message}`, detail: { tool: tool.name, status: result.status } });
        }
        return toMcpResult(result);
      },
    );
  }
}

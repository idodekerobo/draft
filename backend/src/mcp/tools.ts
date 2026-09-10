import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serviceClient } from "../db/client";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../observability/record-query-log";
import { getWorkspaceContext } from "../services/workspace-context";
import { listSkills, readSkill } from "../services/skills";

/** Derives the caller's single workspace server-side; no tool takes a workspaceId argument. */
async function resolveCallerWorkspaceId(userId: string): Promise<string | null> {
  const { data: user } = await serviceClient
    .from("users")
    .select("primary_team_id")
    .eq("id", userId)
    .maybeSingle<{ primary_team_id: string | null }>();
  if (!user?.primary_team_id) return null;

  const { data: workspace } = await serviceClient
    .from("workspaces")
    .select("id")
    .eq("team_id", user.primary_team_id)
    .eq("access_mode", "team_default")
    .maybeSingle<{ id: string }>();
  return workspace?.id ?? null;
}

/** Resolves the caller's workspace, checks access, runs `run`, and logs the query. */
async function withWorkspace<T>(
  userId: string,
  command: AgentQueryLogCommand,
  args: Record<string, unknown>,
  run: (workspaceId: string) => Promise<T>,
): Promise<{ isError: true; text: string } | { isError: false; result: T }> {
  const workspaceId = await resolveCallerWorkspaceId(userId);
  if (!workspaceId) return { isError: true, text: "no_workspace" };

  const denied = await assertWorkspaceAccess(workspaceId, userId);
  if (denied) return { isError: true, text: `forbidden (${denied.status})` };

  const result = await run(workspaceId);
  void recordAgentQueryLog(serviceClient, {
    workspaceId,
    userId,
    command,
    argsJson: args,
    resultBytes: JSON.stringify(result).length,
  });
  return { isError: false, result };
}

/** Builds the read-only tool surface for one already-verified caller (see mcp/route.ts). */
export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: "draft", version: "1.0.0" });

  server.registerTool(
    "context.list",
    {
      description: "List the context dimensions available for the caller's workspace (each a top-level folder under the workspace's company-brain context, e.g. 'product', 'engineering').",
      inputSchema: z.object({}),
    },
    async () => {
      const outcome = await withWorkspace(userId, "mcp.context.list", {}, async (workspaceId) => {
        const result = await getWorkspaceContext(workspaceId);
        if (!result.ok) return { dimensions: [] as Array<{ name: string; path: string }> };
        const dimensions = Object.keys(result.snapshot.documents)
          .map((path) => path.match(/^([^/]+)\/index\.md$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => ({ name: m[1], path: m[0] }));
        return { dimensions };
      });
      if (outcome.isError) return { isError: true, content: [{ type: "text", text: outcome.text }] };
      return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  );

  server.registerTool(
    "context.read",
    {
      description: "Read the caller's workspace context. Pass one or more dimension names, or omit to read all.",
      inputSchema: z.object({
        dimensions: z.array(z.string()).optional().describe("Dimension names to read; omit for all."),
      }),
    },
    async (args) => {
      const outcome = await withWorkspace(userId, "mcp.context.read", args, async (workspaceId) => {
        const result = await getWorkspaceContext(workspaceId);
        if (!result.ok) return { error: result.error };
        const wanted = args.dimensions?.length
          ? new Set(args.dimensions)
          : null;
        const documents = Object.entries(result.snapshot.documents)
          .filter(([path]) => {
            if (!wanted) return true;
            const match = path.match(/^([^/]+)\//);
            return match ? wanted.has(match[1]) : false;
          })
          .map(([path, doc]) => ({ path, ...doc }));
        return {
          versionId: result.snapshot.versionId,
          versionNumber: result.snapshot.versionNumber,
          contentHash: result.snapshot.contentHash,
          createdAt: result.snapshot.createdAt,
          documents,
        };
      });
      if (outcome.isError) return { isError: true, content: [{ type: "text", text: outcome.text }] };
      return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  );

  server.registerTool(
    "skills.list",
    {
      description: "List the skills (reusable playbooks/templates) available in the caller's workspace.",
      inputSchema: z.object({}),
    },
    async () => {
      const outcome = await withWorkspace(userId, "mcp.skills.list", {}, async (workspaceId) => {
        const result = await listSkills(workspaceId);
        if (!result.ok) return { error: result.error };
        return { skills: result.skills };
      });
      if (outcome.isError) return { isError: true, content: [{ type: "text", text: outcome.text }] };
      return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  );

  server.registerTool(
    "skills.read",
    {
      description: "Read one skill's full content by name.",
      inputSchema: z.object({
        name: z.string().describe("The skill's name, as returned by skills.list."),
      }),
    },
    async (args) => {
      const outcome = await withWorkspace(userId, "mcp.skills.read", args, async (workspaceId) => {
        const result = await readSkill(workspaceId, args.name);
        if (!result.ok) return { error: result.error };
        return result.skill;
      });
      if (outcome.isError) return { isError: true, content: [{ type: "text", text: outcome.text }] };
      return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  );

  // TODO: sessions.list/read/search — needs a service extraction from
  // routes/sessions.ts first (window-merging/truncation logic).

  return server;
}

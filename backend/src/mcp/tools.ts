import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serviceClient } from "../db/client";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../observability/record-query-log";
import { getWorkspaceContext } from "../services/workspace-context";
import { listSkills, readSkill } from "../services/skills";
import { readSource, searchSources } from "../services/sources";

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
    resultBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
  });
  return { isError: false, result };
}

/** Builds the read-only tool surface for one already-verified caller (see mcp/route.ts). */
export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: "draft", version: "1.0.0" });

  server.registerTool(
    "context.list",
    {
      description: "List dimensions in Draft's maintained business map. Use context for orientation; use sources.search when you need cross-provider evidence beyond the synthesized map.",
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
      description: "Read Draft's maintained business map. For direct evidence, search sources and then read the selected source; the calling agent owns investigation and answer generation.",
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
    "sources.search",
    {
      description: "Search current cross-provider source evidence using PostgreSQL keyword search. Search covers each source's stored default representation, which may be a summary, rendered source, or mixed content; original transcripts are not universally searchable.",
      inputSchema: z.object({
        query: z.string().min(1).max(512),
        provider: z.string().optional(),
        type: z.array(z.string()).optional(),
        since: z.string().optional().describe("Inclusive UTC date or timestamp."),
        until: z.string().optional().describe("Exclusive UTC date or timestamp."),
        limit: z.number().int().min(1).max(100).optional(),
        max_bytes: z.number().int().min(1024).max(262144).optional(),
        cursor: z.string().optional(),
      }),
    },
    async (args) => {
      const logArgs = { ...args, cursor: args.cursor ? "[redacted]" : undefined };
      const outcome = await withWorkspace(userId, "mcp.sources.search", logArgs, async (workspaceId) => {
        const result = await searchSources(serviceClient, workspaceId, userId, args);
        return result.ok ? result.value : { error: result.error };
      });
      if (outcome.isError) return { isError: true, content: [{ type: "text", text: outcome.text }] };
      return { content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  );

  server.registerTool(
    "sources.read",
    {
      description: "Read one authorized source by source_item_id. Default returns stored searchable content; request transcript, messages, or structured only when search reports that representation as available. Reads are bounded and version-bound.",
      inputSchema: z.object({
        source_item_id: z.string().uuid(),
        representation: z.enum(["default", "transcript", "messages", "structured"]).optional(),
        max_bytes: z.number().int().min(1024).max(262144).optional(),
        cursor: z.string().optional(),
      }),
    },
    async (args) => {
      const logArgs = { ...args, cursor: args.cursor ? "[redacted]" : undefined };
      const outcome = await withWorkspace(userId, "mcp.sources.read", logArgs, async (workspaceId) => {
        const result = await readSource(serviceClient, workspaceId, userId, args);
        return result.ok ? result.value : { error: result.error };
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

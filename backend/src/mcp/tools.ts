import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serviceClient } from "../db/client";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../observability/record-query-log";
import { createContextExportLink, exportInstructions } from "../context-export/link";
import { getWorkspaceContext } from "../services/workspace-context";
import { listRoutines } from "../schedules/service";
import { addSkill, listSkills, readSkill } from "../services/skills";
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

/** Builds the tool surface for one already-verified caller; write tools also need the `write` scope (see mcp/route.ts). */
export function buildMcpServer(userId: string, scopes: string[] = []): McpServer {
  const server = new McpServer(
    {
      name: "draft",
      version: "1.0.0",
      title: "Draft",
      description:
        "Self-updating documentation about everything happening in the company: product, team, and priorities. You can also read and search sources directly. Docs: https://github.com/idodekerobo/draft/tree/main/docs",
      websiteUrl: "https://draftai.us",
    },
    {
      instructions:
        "Draft is the company's self-updating documentation covering product, team, and priorities, kept current automatically. Start with context.list to see available dimensions, then context.read to pull them. To save the whole context as files on disk, use context.export and follow its instructions. The memory dimension is a chronological log rather than a current-state snapshot: pass period (e.g. dimensions: [\"memory\"], period: \"this-week\") to read one day/week/month of it instead of the whole log. For direct evidence beyond the documentation, use sources.search and sources.read. Check skills.list and skills.read for reusable team playbooks before improvising a new approach. When the user asks you to save a workflow as a skill, use skills.add. Use routines.list to see what runs on a schedule (context updates, session summaries, Slack sync) and when each runs next.",
    },
  );

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
      description: "Read Draft's maintained business map. For direct evidence, search sources and then read the selected source; the calling agent owns investigation and answer generation. For the memory dimension (a chronological log, not a current-state file), pass period to read one day/week/month document instead of the whole accumulated log -- e.g. dimensions: [\"memory\"], period: \"this-week\".",
      inputSchema: z.object({
        dimensions: z.array(z.string()).optional().describe("Dimension names to read; omit for all."),
        period: z.string().optional().describe("today|yesterday|this-week|last-week|this-month|last-month, or an explicit id (YYYY-MM-DD, week-YYYY-MM-DD, YYYY-MM). Only valid with dimensions: [\"memory\"]."),
      }),
    },
    async (args) => {
      const outcome = await withWorkspace(userId, "mcp.context.read", args, async (workspaceId) => {
        if (args.period && args.dimensions?.length !== 1) {
          return { error: "period requires exactly one dimension, e.g. dimensions: [\"memory\"]" };
        }
        // Which dimension supports periods is workspace-context.ts's call --
        // it returns "dimension does not support periods: ..." for anything
        // else, the same way the CLI's HTTP route surfaces it.
        const result = await getWorkspaceContext(workspaceId, { dimension: args.dimensions?.[0], period: args.period });
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
    "context.export",
    {
      description: "Get a short-lived download link to the full context as a zip of markdown files (all dimensions, including memory). Prefer this over context.read when the user wants the files on disk; the bytes skip your context window. Follow the returned instructions to fetch and unzip.",
      inputSchema: z.object({}),
    },
    async () => {
      const outcome = await withWorkspace(userId, "mcp.context.export", {}, async (workspaceId) => {
        const result = await createContextExportLink(workspaceId, userId);
        if (!result.ok) return { error: result.error };
        return { ...result.link, instructions: exportInstructions(result.link) };
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
    "routines.list",
    {
      description:
        "List the routines (scheduled background tasks) in the caller's workspace, with schedule, cron expression, enabled state, and next run.",
      inputSchema: z.object({}),
    },
    async () => {
      const outcome = await withWorkspace(userId, "mcp.routines.list", {}, async (workspaceId) => ({
        routines: await listRoutines(workspaceId),
      }));
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

  server.registerTool(
    "skills.add",
    {
      description: "Create a new shared skill for the whole team. Use only when the user asks to save a skill. Write the description for a teammate who was not in this session. Fails with duplicate_name if the name exists; it cannot overwrite a skill.",
      inputSchema: z.object({
        name: z.string().describe("Lowercase words joined by hyphens, e.g. weekly-customer-recap. Max 64 characters."),
        description: z.string().min(1).describe("One or two sentences on what the skill does and when to use it."),
        content: z.string().min(1).describe("The full skill in markdown. May start with YAML frontmatter."),
        license: z.string().optional(),
        compatibility: z.string().optional(),
        allowed_tools: z.string().optional(),
      }),
    },
    async (args) => {
      if (!scopes.includes("write")) {
        return {
          isError: true,
          content: [{ type: "text", text: "insufficient_scope: this connection only has read access. Re-authorize the Draft connection and approve write access." }],
        };
      }
      const logArgs = { name: args.name, contentBytes: Buffer.byteLength(args.content, "utf8") };
      const outcome = await withWorkspace(userId, "mcp.skills.add", logArgs, async (workspaceId) => {
        const result = await addSkill(workspaceId, userId, args);
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

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createDraftToolRegistry } from "../agent-runs/tools";
import { userInvokeDeps } from "../agent-runs/user-gateway";
import { registerGatewayTools, type McpGateway } from "./gateway-tools";
import { serviceClient } from "../db/client";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { recordAgentQueryLog, type AgentQueryLogCommand } from "../observability/record-query-log";
import { listRoutines } from "../schedules/service";
import { addSkill, listSkills, readSkill } from "../services/skills";

// Built with each server, which is built per request, so nothing is shared between callers.
function gatewayFor(override?: McpGateway): McpGateway {
  return (
    override ?? {
      deps: userInvokeDeps(serviceClient, createDraftToolRegistry(serviceClient)),
      resolveWorkspaceId: resolveCallerWorkspaceId,
    }
  );
}

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
export function buildMcpServer(userId: string, scopes: string[] = [], gatewayOverride?: McpGateway): McpServer {
  const gateway = gatewayFor(gatewayOverride);
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
        "Draft is the company's self-updating documentation covering product, team, and priorities. To get the latest information, call context.read with dimensions: [\"memory\"] and a period. Memory is a chronological log of daily, weekly, and monthly summaries. A period is a day (YYYY-MM-DD), a week (week-YYYY-MM-DD, using that week's Monday), or a month (YYYY-MM); aliases like today, this-week, and last-month also work. For a longer span, read several periods. Use context.list and context.read with other dimensions for stable background. For direct evidence, use sources.search and sources.read. Use context.export only to save the full context as files on disk. Use skills.list and skills.read only when the user asks for a saved skill or workflow, and skills.add only when the user asks to save one. Use routines.list to see what runs on a schedule (context updates, session summaries, Slack sync) and when each runs next.",
    },
  );

  registerGatewayTools(server, userId, gateway);

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

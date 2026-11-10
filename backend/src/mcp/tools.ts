import { McpServer } from "@modelcontextprotocol/server";
import { createDraftToolRegistry } from "../agent-runs/tools";
import { userInvokeDeps } from "../agent-runs/user-gateway";
import { registerGatewayTools, type McpGateway } from "./gateway-tools";
import { serviceClient } from "../db/client";

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

  registerGatewayTools(server, userId, gateway, scopes);

  // TODO: sessions.list/read/search — needs a service extraction from
  // routes/sessions.ts first (window-merging/truncation logic).

  return server;
}

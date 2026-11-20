import { McpServer } from "@modelcontextprotocol/server";
import { createDraftToolRegistry } from "../metaharness/tools/definitions";
import { userInvokeDeps } from "../metaharness/tools/user-gateway";
import { registerGatewayTools, type McpGateway } from "./gateway-tools";
import { serviceClient } from "../db/client";
import { toolConnectionProvidersOrNone } from "../ingestion/gmail/access";

// Built with each server, which is built per request, so nothing is shared between callers.
function gatewayFor(override?: McpGateway): McpGateway {
  return (
    override ?? {
      deps: userInvokeDeps(serviceClient, createDraftToolRegistry(serviceClient)),
      resolveWorkspaceId: resolveCallerWorkspaceId,
      connectionProviders: (workspaceId, userId) => toolConnectionProvidersOrNone(serviceClient, workspaceId, userId, "mcp"),
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

/** Fails closed: any lookup failure offers no connection-gated tool. */
async function callerProviders(gateway: McpGateway, userId: string): Promise<ReadonlySet<string>> {
  if (!gateway.connectionProviders) return new Set();
  try {
    const workspaceId = await gateway.resolveWorkspaceId(userId);
    return workspaceId ? await gateway.connectionProviders(workspaceId, userId) : new Set();
  } catch (error) {
    console.error(JSON.stringify({ source: "mcp", event: "personal_connections_lookup_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Set();
  }
}

/** Builds the tool surface for one already-verified caller; write tools also need the `write` scope (see mcp/route.ts). */
export async function buildMcpServer(userId: string, scopes: string[] = [], gatewayOverride?: McpGateway): Promise<McpServer> {
  const gateway = gatewayFor(gatewayOverride);
  const providers = await callerProviders(gateway, userId);
  const server = new McpServer(
    {
      name: "draft",
      version: "1.0.0",
      title: "Draft",
      description:
        "Self-updating documentation about everything happening in the company: product, team, and priorities. Draft app conversations are sessions; ingested evidence, including captured coding sessions, is under sources. Docs: https://github.com/idodekerobo/draft/tree/main/docs",
      websiteUrl: "https://draftai.us",
    },
    {
      instructions:
        "Draft is the company's self-updating documentation covering product, team, and priorities. To get the latest information, call context.read with dimensions: [\"memory\"] and a period. Memory is a chronological log of daily, weekly, and monthly summaries. A period is a day (YYYY-MM-DD), a week (week-YYYY-MM-DD, using that week's Monday), or a month (YYYY-MM); aliases like today, this-week, and last-month also work. For a longer span, read several periods. Use context.list and context.read with other dimensions for stable background. Draft app conversations are sessions: use sessions.list and sessions.read to browse them. Ingested evidence is sources: use sources.list to browse, sources.search to find content, and sources.read to inspect an item. Use context.export only to save the full context as files on disk. Use skills.list and skills.read only when the user asks for a saved skill or workflow, and skills.add only when the user asks to save one. Routines are agents that run on a schedule or when something happens (a meeting ends, a pull request merges). Call routines.options before routines.create or update: it lists valid triggers, presets, agents, channels and repos. Use routines.list for every routine's settings, routines.run to start one, and routines.runs to read results (add transcript: true only when you need the steps). A trigger or access whose provider isn't connected is refused: call connections.list, ask the person, then connections.connect, which returns a link they open themselves. Never ask a person to paste a key into the chat. Use activity.list for everything the workspace's agents have run; lists return nextCursor for older pages.",
    },
  );

  registerGatewayTools(server, userId, gateway, scopes, providers);

  return server;
}

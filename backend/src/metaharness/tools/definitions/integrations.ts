import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { INTEGRATION_PROVIDERS, createConnectRequest, listIntegrations } from "../../../integrations/service";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

export function createIntegrationTools(client: SupabaseClient) {
  const list = defineTool({
    name: "connections.list", mcp: true, allowedOrigins: ["person"], input: z.object({}),
    description: "The workspace's connections (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): whether each is connected, what it brings in, which routine triggers and abilities it unlocks, and how to connect it.",
    handler: async ({ caller }) => {
      const user = requireUser(caller, "connections.list");
      return { status: "ok", output: { integrations: await listIntegrations(client, user.workspaceId, user.userId) } };
    },
  });

  const connect = defineTool({
    name: "connections.connect", mcp: true, allowedOrigins: ["person"],
    input: z.object({ provider: z.enum(INTEGRATION_PROVIDERS) }),
    description: "Start connecting a provider. Answers with a link for the person to open: they sign in or enter the key there, so it never passes through you. Ask them before calling. Call connections.list afterwards to see when it is connected.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "connections.connect");
      const result = await createConnectRequest(client, { workspaceId: user.workspaceId, userId: user.userId, provider: input.provider, via: user.via === "cli" || user.via === "mcp" ? user.via : "http" });
      if (result.status === "too_many_requests") return refuse("too_many_requests", "Too many open connect links. Let the open ones expire (15 minutes) and try again.");
      return { status: "ok", output: result };
    },
  });

  return [list, connect];
}

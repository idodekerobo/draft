import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { describeError } from "../../../errors/describe-error";
import { disconnectConnection } from "../../../integrations/disconnect";
import { INTEGRATION_PROVIDERS, createConnectRequest, listIntegrations } from "../../../integrations/service";
import type { ConnectionProvider } from "../../../types/enums";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

export function createIntegrationTools(client: SupabaseClient) {
  const list = defineTool({
    name: "connections.list", mcp: true, allowedOrigins: ["person"], input: z.object({}),
    description: "The workspace's connections (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): whether each is connected, what it brings in, which routine triggers and abilities it unlocks, and how to connect it.",
    handler: async ({ caller }) => {
      const user = requireUser(caller, "connections.list");
      return { status: "ok", output: { connections: await listIntegrations(client, user.workspaceId, user.userId) } };
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

  const disconnect = defineTool({
    name: "connections.disconnect", mcp: true, allowedOrigins: ["person"], destructive: true,
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      accountKind: z.enum(["personal", "workspace"]).optional().describe("Granola only: which account to disconnect. Defaults to personal."),
      confirm: z.literal(true).optional().describe("Pass true to disconnect. Without it the call only reports what would stop."),
    }),
    description: "Disconnect a provider you connected. Call once without confirm to see what would stop, show that to the person, then call again with confirm: true. Only the person who connected it can disconnect it.",
    auditArguments: (input) => ({ provider: input.provider, accountKind: input.accountKind ?? null, confirm: input.confirm === true }),
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "connections.disconnect");
      if (input.provider === "claude_session") return refuse("not_supported", "Claude Code sessions are not disconnected through Draft.");
      if (input.accountKind && input.provider !== "granola") return refuse("invalid_account_kind", "accountKind applies to Granola only.");

      const current = (await listIntegrations(client, user.workspaceId, user.userId)).find((item) => item.provider === input.provider);
      if (!current || current.status === "not_connected") {
        return { status: "ok", output: { status: "not_connected", provider: input.provider, message: `${current?.label ?? input.provider} is not connected.` } };
      }
      if (input.confirm !== true) {
        const stops = {
          ingests: current.ingests,
          triggers: current.triggers.map((trigger) => trigger.label),
          abilities: current.abilities,
        };
        return {
          status: "ok",
          output: {
            status: "confirmation_required",
            provider: input.provider,
            connectedByYou: current.connectedByYou,
            stops,
            message: `Disconnecting ${current.label} stops new items from coming in, and any routine that uses it stops working. Facts already in company context stay. To go ahead, call connections.disconnect again with {"provider":"${input.provider}","confirm":true}.`,
          },
          summary: "Asked to confirm",
        };
      }

      const result = await disconnectConnection(client, {
        workspaceId: user.workspaceId,
        userId: user.userId,
        provider: input.provider as ConnectionProvider,
        accountKind: input.provider === "granola" ? (input.accountKind ?? "personal") : null,
      });
      if (!result.ok) throw new Error(`disconnect_failed: ${describeError(result.error)}`);
      if (result.outcome === "not_owner") return refuse("not_connection_owner", `Only the person who connected ${current.label} can disconnect it.`);
      if (result.outcome === "not_found") return { status: "ok", output: { status: "not_connected", provider: input.provider, message: `${current.label} is not connected.` } };
      return { status: "ok", output: { status: "disconnected", provider: input.provider, message: `${current.label} is disconnected.` }, summary: `Disconnected ${current.label}` };
    },
  });

  return [list, connect, disconnect];
}

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ROUTINE_TRIGGERS } from "draft-core/routines";
import { loadConfig } from "../config";

/** The providers a workspace can connect, what each brings in, and what it lets a routine do. */
export const INTEGRATIONS = [
  { provider: "github", cliName: "github", label: "GitHub", ingests: "pull requests and commits", abilities: ["A routine can read repos, or open pull requests in them"] },
  { provider: "slack", cliName: "slack", label: "Slack", ingests: "messages in the channels you pick", abilities: ["A routine can post in channels", "A routine can message teammates"] },
  { provider: "linear", cliName: "linear", label: "Linear", ingests: "issues, comments and projects", abilities: [] },
  { provider: "fireflies", cliName: "fireflies", label: "Fireflies", ingests: "meeting transcripts and summaries", abilities: [] },
  { provider: "granola", cliName: "granola", label: "Granola", ingests: "meeting notes", abilities: [] },
  { provider: "claude_session", cliName: "claude-code", label: "Claude Code", ingests: "summaries of captured Claude Code sessions", abilities: [] },
] as const;
export type IntegrationProvider = (typeof INTEGRATIONS)[number]["provider"];
export const INTEGRATION_PROVIDERS = INTEGRATIONS.map((entry) => entry.provider) as [IntegrationProvider, ...IntegrationProvider[]];

const LIVE = new Set(["active", "degraded"]);
const REQUEST_TTL_MS = 15 * 60_000;
const MAX_OPEN_REQUESTS = 10;

export interface Integration {
  provider: IntegrationProvider;
  label: string;
  /** "pending": saved, waiting for the provider's first event (Fireflies and Granola wait for a webhook). */
  status: "connected" | "pending" | "needs_reconnect" | "not_connected";
  /** True when the caller's own account is one of the live connections. */
  connectedByYou: boolean;
  ingests: string;
  /** Routine triggers this connection offers. */
  triggers: Array<{ event: string; label: string }>;
  abilities: ReadonlyArray<string>;
  connect: { cli: string; mcp: string };
}

/** Every provider and its state in the workspace, with what it unlocks and how to connect it. */
export async function listIntegrations(client: SupabaseClient, workspaceId: string, userId: string): Promise<Integration[]> {
  const { data, error } = await client.from("source_connections").select("provider, status, connected_by_user_id").eq("workspace_id", workspaceId).in("provider", INTEGRATION_PROVIDERS);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ provider: string; status: string; connected_by_user_id: string | null }>;
  return INTEGRATIONS.map((entry) => {
    const mine = rows.filter((row) => row.provider === entry.provider && row.status !== "revoked");
    const live = mine.filter((row) => LIVE.has(row.status));
    return {
      provider: entry.provider,
      label: entry.label,
      status: live.length ? "connected" : mine.some((row) => row.status === "pending") ? "pending" : mine.length ? "needs_reconnect" : "not_connected",
      connectedByYou: live.some((row) => row.connected_by_user_id === userId),
      ingests: entry.ingests,
      triggers: ROUTINE_TRIGGERS.filter((trigger) => trigger.provider === entry.provider).map(({ event, label }) => ({ event, label })),
      abilities: entry.abilities,
      connect: { cli: `draft integrations connect ${entry.cliName}`, mcp: `integrations.connect {"provider":"${entry.provider}"}` },
    };
  });
}

export const hashConnectToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type ConnectResult =
  | { status: "connected"; provider: IntegrationProvider }
  | { status: "action_required"; action: string; provider: IntegrationProvider; url: string; expiresAt: string; message: string }
  | { status: "too_many_requests" };

/**
 * A link the person opens to connect the provider themselves. It works once, only for them, for 15 minutes,
 * and only its hash is stored. Nothing is created when the provider is already connected.
 */
export async function createConnectRequest(
  client: SupabaseClient,
  input: { workspaceId: string; userId: string; provider: IntegrationProvider; via: "mcp" | "cli" | "http" },
  deps: { now?: Date; appUrl?: string } = {},
): Promise<ConnectResult> {
  const now = deps.now ?? new Date();
  const entry = INTEGRATIONS.find((item) => item.provider === input.provider)!;
  const current = (await listIntegrations(client, input.workspaceId, input.userId)).find((item) => item.provider === input.provider);
  if (current?.status === "connected" || current?.status === "pending") return { status: "connected", provider: input.provider };

  const { count, error: countError } = await client
    .from("connection_requests")
    .select("id", { count: "exact", head: true })
    .eq("requested_by_user_id", input.userId)
    .eq("status", "pending")
    .gt("expires_at", now.toISOString());
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_OPEN_REQUESTS) return { status: "too_many_requests" };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS).toISOString();
  const { error } = await client.from("connection_requests").insert({
    workspace_id: input.workspaceId,
    requested_by_user_id: input.userId,
    provider: input.provider,
    token_hash: hashConnectToken(token),
    status: "pending",
    created_via: input.via,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return {
    status: "action_required",
    action: `connect_${entry.cliName.replace("-", "_")}`,
    provider: input.provider,
    url: `${deps.appUrl ?? loadConfig().appUrl}/connect/${token}`,
    expiresAt,
    message: `Ask the person to open this link and connect ${entry.label}. Only they can use it, once, before it expires. Call integrations.list to see when it is connected.`,
  };
}

export type ConnectRequestRow = { id: string; workspace_id: string; requested_by_user_id: string; provider: IntegrationProvider; status: "pending" | "completed"; expires_at: string };

/** The request behind a link, or why it can't be used. Someone else's link reads as unknown, so it reveals nothing. */
export async function findConnectRequest(client: SupabaseClient, token: string, userId: string, now: Date = new Date()): Promise<{ ok: true; request: ConnectRequestRow } | { ok: false; error: "expired_or_unknown" | "already_used" }> {
  const { data, error } = await client.from("connection_requests").select("id, workspace_id, requested_by_user_id, provider, status, expires_at").eq("token_hash", hashConnectToken(token)).maybeSingle();
  if (error) throw error;
  const request = data as ConnectRequestRow | null;
  if (!request || request.requested_by_user_id !== userId || new Date(request.expires_at) <= now) return { ok: false, error: "expired_or_unknown" };
  if (request.status === "completed") return { ok: false, error: "already_used" };
  return { ok: true, request };
}

/** Closes the request once the provider is connected. Returns false while it is not connected yet. */
export async function completeConnectRequest(client: SupabaseClient, request: ConnectRequestRow, now: Date = new Date()): Promise<boolean> {
  const current = (await listIntegrations(client, request.workspace_id, request.requested_by_user_id)).find((item) => item.provider === request.provider);
  if (current?.status !== "connected" && current?.status !== "pending") return false;
  const { error } = await client.from("connection_requests").update({ status: "completed", completed_at: now.toISOString() }).eq("id", request.id).eq("status", "pending");
  if (error) throw error;
  return true;
}

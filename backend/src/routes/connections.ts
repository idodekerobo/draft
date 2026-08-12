import { randomBytes, randomUUID } from "node:crypto";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import {
  CURRENT_CREDENTIAL_KEY_VERSION,
  encryptCredentialPayload,
} from "../credentials/crypto";
import { resolveProviderCredential } from "../credentials/resolve-provider-credential";
import { loadConfig } from "../config";
import { registerFirefliesReconciliationTask } from "../ingestion/fireflies/reconcile";
import { restartSlackListener, stopSlackListener } from "../ingestion/slack/bootstrap";
import { registerSlackBatchMaterializationTask } from "../ingestion/slack/materialize-batches";
import type { SourceConnectionRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

type ConnectionsRequest = Bun.BunRequest<"/workspaces/:id/connections">;
type ConnectionProviderRequest = Bun.BunRequest<"/workspaces/:id/connections/:provider">;
type ConnectionChannelsRequest = Bun.BunRequest<"/workspaces/:id/connections/:provider/channels">;

interface SlackConnectBody {
  provider: "slack";
  bot_token: string;
  app_token: string;
  channel_ids: string[];
}

interface FirefliesConnectBody {
  provider: "fireflies";
  api_token: string;
}

interface ClaudeCodeConnectBody {
  provider: "claude_code";
  token: string;
}

type ConnectBody = SlackConnectBody | FirefliesConnectBody | ClaudeCodeConnectBody;
type SupportedProvider = "slack" | "fireflies" | "claude_code";

interface SlackConnectResponse {
  ok: true;
}

interface FirefliesConnectResponse {
  ok: true;
  webhookUrl: string;
  webhookSecret: string;
}

interface SlackChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
  allowlisted: boolean;
}

interface SlackApiError extends Error {
  slackCode?: string;
}

const config = loadConfig();

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return value === "slack" || value === "fireflies" || value === "claude_code";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSlackConnectBody(value: unknown): value is SlackConnectBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<SlackConnectBody>;
  return body.provider === "slack" &&
    isNonEmptyString(body.bot_token) &&
    isNonEmptyString(body.app_token) &&
    Array.isArray(body.channel_ids) &&
    body.channel_ids.every((channelId) => isNonEmptyString(channelId));
}

function isFirefliesConnectBody(value: unknown): value is FirefliesConnectBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<FirefliesConnectBody>;
  return body.provider === "fireflies" && isNonEmptyString(body.api_token);
}

function isClaudeCodeConnectBody(value: unknown): value is ClaudeCodeConnectBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<ClaudeCodeConnectBody>;
  return body.provider === "claude_code" && isNonEmptyString(body.token);
}

function isChannelIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((channelId) => isNonEmptyString(channelId));
}

// Return safe error codes to clients; log details for server diagnostics.
function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, operation: "auth", errorCode: error, error: detail });
  }
  return Response.json({ error }, { status });
}

async function listPublicSlackChannels(botToken: string): Promise<Omit<SlackChannel, "allowlisted">[]> {
  const channels: Omit<SlackChannel, "allowlisted">[] = [];
  let cursor = "";

  do {
    const query = new URLSearchParams({
      types: "public_channel",
      limit: "200",
      exclude_archived: "true",
    });
    if (cursor) query.set("cursor", cursor);

    const response = await fetch(`https://slack.com/api/conversations.list?${query.toString()}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await response.json() as {
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string; num_members?: number; is_member?: boolean }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) {
      const error = new Error(`conversations.list failed: ${data.error ?? "unknown"}`) as SlackApiError;
      error.slackCode = data.error;
      throw error;
    }

    channels.push(...(data.channels ?? []).map((channel) => ({
      id: channel.id,
      name: channel.name,
      memberCount: channel.num_members ?? 0,
      isMember: channel.is_member ?? false,
    })));
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor);

  return channels.sort((a, b) => b.memberCount - a.memberCount);
}

async function joinPublicSlackChannels(botToken: string, channelIds: string[]): Promise<void> {
  for (const channelId of channelIds) {
    const response = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ channel: channelId }),
    });
    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok && data.error !== "already_in_channel") {
      const error = new Error(`conversations.join failed for ${channelId}: ${data.error ?? "unknown"}`) as SlackApiError;
      error.slackCode = data.error;
      throw error;
    }
  }
}

export const GET = withAuth<ConnectionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("source_connections")
    .select("provider, status, display_name, last_success_at, last_error_at, config_json")
    .eq("workspace_id", req.params.id)
    .in("provider", ["slack", "fireflies"]);
  if (error) return errorResponse("lookup_failed", 500, error, req.params.id);

  const connections: Array<{
    provider: string;
    status: string | null;
    display_name: string | null;
    last_success_at: string | null;
    last_error_at: string | null;
    channel_ids: string[];
    connected?: boolean;
  }> = ((data ?? []) as Array<Pick<
    SourceConnectionRow,
    "provider" | "status" | "display_name" | "last_success_at" | "last_error_at" | "config_json"
  >>).map((connection) => ({
    provider: connection.provider,
    status: connection.status,
    display_name: connection.display_name,
    last_success_at: connection.last_success_at,
    last_error_at: connection.last_error_at,
    channel_ids: Array.isArray(connection.config_json?.channel_ids)
      ? connection.config_json.channel_ids.filter((value): value is string => typeof value === "string")
      : [],
  }));

  const { data: workspaceData, error: workspaceError } = await serviceClient
    .from("workspaces")
    .select("inference_credential_id")
    .eq("id", req.params.id)
    .single();
  if (workspaceError) return errorResponse("workspace_lookup_failed", 500, workspaceError, req.params.id);

  const inferenceCredentialId = (workspaceData as { inference_credential_id: string | null } | null)
    ?.inference_credential_id ?? null;
  let claudeCodeStatus: string | null = null;
  if (inferenceCredentialId) {
    const { data: credentialData, error: credentialError } = await serviceClient
      .from("credentials")
      .select("status")
      .eq("id", inferenceCredentialId)
      .eq("workspace_id", req.params.id)
      .maybeSingle();
    if (credentialError) return errorResponse("credential_lookup_failed", 500, credentialError, req.params.id);
    claudeCodeStatus = (credentialData as { status: string } | null)?.status ?? null;
  }
  connections.push({
    provider: "claude_code",
    status: claudeCodeStatus,
    display_name: null,
    last_success_at: null,
    last_error_at: null,
    channel_ids: [],
    connected: claudeCodeStatus === "active",
  });

  return Response.json({ connections });
});

export const CHANNELS_GET = withAuth<ConnectionChannelsRequest>(async (req, caller) => {
  if (req.params.provider !== "slack") return errorResponse("invalid_provider", 400);

  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data: connection, error } = await serviceClient
    .from("source_connections")
    .select("config_json")
    .eq("workspace_id", req.params.id)
    .eq("provider", "slack")
    .eq("status", "active")
    .maybeSingle<Pick<SourceConnectionRow, "config_json">>();
  if (error) return errorResponse("connection_lookup_failed", 500, error, req.params.id);
  if (!connection) return errorResponse("not_found", 404);

  try {
    const credential = await resolveProviderCredential(req.params.id, "slack", serviceClient);
    const channels = await listPublicSlackChannels(credential.bot_token);
    const allowlist = new Set(
      Array.isArray(connection.config_json?.channel_ids)
        ? connection.config_json.channel_ids.filter((value): value is string => typeof value === "string")
        : [],
    );
    return Response.json({
      ok: true,
      channels: channels.map((channel) => ({ ...channel, allowlisted: allowlist.has(channel.id) })),
    });
  } catch (error) {
    const slackCode = (error as SlackApiError).slackCode;
    return errorResponse(slackCode ? `slack_channel_list_failed:${slackCode}` : "slack_channel_list_failed", 502, error, req.params.id);
  }
});

export const POST = withAuth<ConnectionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", 400);
  }

  if (!body || typeof body !== "object" || !isSupportedProvider((body as { provider?: unknown }).provider)) {
    return errorResponse("invalid_provider", 400);
  }
  if (!isSlackConnectBody(body) && !isFirefliesConnectBody(body) && !isClaudeCodeConnectBody(body)) {
    return errorResponse("invalid_body", 400);
  }

  if (body.provider === "claude_code") {
    // Workspace-level credential, not a source_connections row: no live probe,
    // no scheduled task — a bad token surfaces on the first real run via the
    // existing 401/pause/reconnect handling.
    const encryptedToken = encryptCredentialPayload(body.token, CURRENT_CREDENTIAL_KEY_VERSION);

    const { data: existingCredential, error: existingCredentialError } = await serviceClient
      .from("credentials")
      .select("id")
      .eq("workspace_id", req.params.id)
      .eq("provider", "claude_code")
      .maybeSingle();
    if (existingCredentialError) return errorResponse("credential_lookup_failed", 500, existingCredentialError, req.params.id);

    let claudeCodeCredentialId: string;
    if (existingCredential) {
      claudeCodeCredentialId = existingCredential.id;
      const { error: updateError } = await serviceClient
        .from("credentials")
        .update({
          encrypted_payload: encryptedToken,
          encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
          status: "active",
        })
        .eq("id", claudeCodeCredentialId)
        .eq("workspace_id", req.params.id);
      if (updateError) return errorResponse("credential_update_failed", 500, updateError, req.params.id);
    } else {
      const { data: insertedCredential, error: insertError } = await serviceClient
        .from("credentials")
        .insert({
          workspace_id: req.params.id,
          provider: "claude_code",
          encrypted_payload: encryptedToken,
          encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
          status: "active",
        })
        .select("id")
        .single();
      if (insertError || !insertedCredential) return errorResponse("credential_insert_failed", 500, insertError, req.params.id);
      claudeCodeCredentialId = insertedCredential.id;
    }

    const { error: workspacePointerError } = await serviceClient
      .from("workspaces")
      .update({ inference_credential_id: claudeCodeCredentialId })
      .eq("id", req.params.id);
    if (workspacePointerError) return errorResponse("workspace_update_failed", 500, workspacePointerError, req.params.id);

    return Response.json({ ok: true });
  }

  const isFireflies = body.provider === "fireflies";
  const isSlack = body.provider === "slack";
  let webhookSecret: string | undefined;
  let plaintext: string;
  if (body.provider === "fireflies") {
    webhookSecret = randomBytes(32).toString("hex");
    plaintext = JSON.stringify({ api_token: body.api_token, webhook_secret: webhookSecret });
  } else if (body.provider === "slack") {
    try {
      await joinPublicSlackChannels(body.bot_token, body.channel_ids);
    } catch (error) {
      const slackCode = (error as SlackApiError).slackCode;
      return errorResponse(slackCode ? `slack_channel_join_failed:${slackCode}` : "slack_channel_join_failed", 502, error, req.params.id);
    }
    plaintext = JSON.stringify({ bot_token: body.bot_token, app_token: body.app_token });
  } else {
    return errorResponse("unsupported_provider", 400);
  }
  const encrypted = encryptCredentialPayload(plaintext, CURRENT_CREDENTIAL_KEY_VERSION);

  const { data: existing, error: existingError } = await serviceClient
    .from("source_connections")
    .select("id, credential_id, connection_key")
    .eq("workspace_id", req.params.id)
    .eq("provider", body.provider)
    .maybeSingle();
  if (existingError) return errorResponse("connection_lookup_failed", 500, existingError, req.params.id);

  let connectionId: string;
  let connectionKey: string;

  if (existing) {
    connectionId = existing.id;
    connectionKey = existing.connection_key;

    if (existing.credential_id) {
      const { data: updatedCredential, error: credentialError } = await serviceClient
        .from("credentials")
        .update({
          encrypted_payload: encrypted,
          encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
        })
        .eq("id", existing.credential_id)
        .eq("workspace_id", req.params.id)
        .select("id");
      if (credentialError || !updatedCredential || updatedCredential.length === 0) {
        return errorResponse("credential_update_failed", 500, credentialError ?? "zero_rows_updated", req.params.id);
      }
    } else {
      const { data: newCredential, error: credentialError } = await serviceClient
        .from("credentials")
        .insert({
          workspace_id: req.params.id,
          provider: body.provider,
          encrypted_payload: encrypted,
          encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
          status: "active",
        })
        .select("id")
        .single();
      if (credentialError || !newCredential) return errorResponse("credential_insert_failed", 500, credentialError, req.params.id);

      const { error: credentialLinkError } = await serviceClient
        .from("source_connections")
        .update({ credential_id: newCredential.id })
        .eq("id", existing.id)
        .eq("workspace_id", req.params.id);
      if (credentialLinkError) return errorResponse("connection_update_failed", 500, credentialLinkError, req.params.id);
    }

    const { error: connectionError } = await serviceClient
      .from("source_connections")
      .update({
        status: "active",
        last_error_at: null,
        ...(body.provider === "slack" ? { config_json: { channel_ids: body.channel_ids } } : {}),
      })
      .eq("id", existing.id)
      .eq("workspace_id", req.params.id)
      .select("id, connection_key")
      .single();
    if (connectionError) return errorResponse("connection_update_failed", 500, connectionError, req.params.id);
  } else {
    const { data: newCredential, error: credentialError } = await serviceClient
      .from("credentials")
      .insert({
        workspace_id: req.params.id,
        provider: body.provider,
        encrypted_payload: encrypted,
        encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
        status: "active",
      })
      .select("id")
      .single();
    if (credentialError || !newCredential) return errorResponse("credential_insert_failed", 500, credentialError, req.params.id);

    // A failed connection insert can leave an orphaned credential.
    connectionKey = randomUUID();
    const { data: newConnection, error: connectionError } = await serviceClient
      .from("source_connections")
      .insert({
        workspace_id: req.params.id,
        provider: body.provider,
        connection_key: connectionKey,
        credential_id: newCredential.id,
        status: "active",
        connected_by_user_id: caller.userId,
        config_json: body.provider === "slack" ? { channel_ids: body.channel_ids } : {},
      })
      .select("id")
      .single();
    if (connectionError || !newConnection) return errorResponse("connection_insert_failed", 500, connectionError, req.params.id);
    connectionId = newConnection.id;
  }

  try {
    if (isFireflies) {
      await registerFirefliesReconciliationTask(
        { id: connectionId, workspace_id: req.params.id },
        serviceClient,
      );
    } else if (isSlack) {
      await registerSlackBatchMaterializationTask(
        { id: connectionId, workspace_id: req.params.id },
        serviceClient,
      );
      await restartSlackListener(connectionId, serviceClient);
    } else {
      return errorResponse("unsupported_provider", 400);
    }
  } catch (err) {
    return errorResponse("schedule_registration_failed", 500, err, req.params.id);
  }

  if (isFireflies) {
    if (!webhookSecret) return errorResponse("webhook_secret_generation_failed", 500, undefined, req.params.id);
    return Response.json({
      ok: true,
      webhookUrl: `${config.apiBaseUrl}/webhooks/fireflies/${connectionKey}`,
      webhookSecret,
    } satisfies FirefliesConnectResponse);
  }
  if (isSlack) {
    return Response.json({ ok: true } satisfies SlackConnectResponse);
  }
  return errorResponse("unsupported_provider", 400);
});

export const PATCH = withAuth<ConnectionProviderRequest>(async (req, caller) => {
  if (req.params.provider !== "slack") return errorResponse("invalid_provider", 400);

  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", 400);
  }
  if (!body || typeof body !== "object" || !isChannelIds((body as { channel_ids?: unknown }).channel_ids)) {
    return errorResponse("invalid_body", 400);
  }

  const channelIds = (body as { channel_ids: string[] }).channel_ids;
  try {
    const credential = await resolveProviderCredential(req.params.id, "slack", serviceClient);
    await joinPublicSlackChannels(credential.bot_token, channelIds);
  } catch (error) {
    const slackCode = (error as SlackApiError).slackCode;
    return errorResponse(slackCode ? `slack_channel_join_failed:${slackCode}` : "slack_channel_join_failed", 502, error, req.params.id);
  }

  const { data: connection, error } = await serviceClient
    .from("source_connections")
    .update({ config_json: { channel_ids: channelIds } })
    .eq("workspace_id", req.params.id)
    .eq("provider", "slack")
    .select("id")
    .maybeSingle();
  if (error) return errorResponse("connection_update_failed", 500, error, req.params.id);
  if (!connection) return errorResponse("not_found", 404);
  return Response.json({ ok: true });
});

export const DELETE = withAuth<ConnectionProviderRequest>(async (req, caller) => {
  if (req.params.provider === "claude_code") return errorResponse("not_supported", 400);
  if (!isSupportedProvider(req.params.provider)) return errorResponse("invalid_provider", 400);

  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data: connection, error: lookupError } = await serviceClient
    .from("source_connections")
    .select("id")
    .eq("workspace_id", req.params.id)
    .eq("provider", req.params.provider)
    .maybeSingle();
  if (lookupError) return errorResponse("connection_lookup_failed", 500, lookupError, req.params.id);
  if (!connection) return Response.json({ ok: true });

  const { error: connectionError } = await serviceClient
    .from("source_connections")
    .update({ status: "revoked" })
    .eq("id", connection.id)
    .eq("workspace_id", req.params.id);
  if (connectionError) return errorResponse("disconnect_failed", 500, connectionError, req.params.id);

  const { error: taskError } = await serviceClient
    .from("scheduled_tasks")
    .update({ enabled: false })
    .eq("workspace_id", req.params.id)
    .eq("task_type", "ingest_source")
    .eq("task_key", connection.id);
  if (taskError) return errorResponse("disconnect_failed", 500, taskError, req.params.id);

  if (req.params.provider === "slack") stopSlackListener(connection.id);

  return Response.json({ ok: true });
});

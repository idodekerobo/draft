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
import { CLAUDE_SESSION_CONNECTION_KEY } from "../ingestion/agent-sessions/constants";
import { registerFirefliesReconciliationTask } from "../ingestion/fireflies/reconcile";
import { restartSlackListener, stopSlackListener } from "../ingestion/slack/bootstrap";
import { registerSlackBatchMaterializationTask } from "../ingestion/slack/materialize-batches";
import {
  joinPublicSlackChannels,
  listPublicSlackChannels,
  SlackProviderError,
} from "../ingestion/slack/provider";
import { createLinearWebhook, LinearProviderError } from "../ingestion/linear/provider";
import { upsertSourceConnection } from "../ingestion/upsert-source-item";
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

interface LinearConnectBody {
  provider: "linear";
  api_token: string;
}

interface ClaudeCodeConnectBody {
  provider: "claude_code";
  token: string;
}

interface ClaudeSessionConnectBody {
  provider: "claude_session";
}

type ConnectBody = SlackConnectBody | FirefliesConnectBody | LinearConnectBody | ClaudeCodeConnectBody | ClaudeSessionConnectBody;
type SupportedProvider = "slack" | "fireflies" | "linear" | "claude_code" | "github" | "claude_session";

interface SlackConnectResponse {
  ok: true;
}

interface FirefliesConnectResponse {
  ok: true;
  webhookUrl: string;
  webhookSecret: string;
}

interface LinearConnectResponse {
  ok: true;
}

const config = loadConfig();

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return (
    value === "slack" ||
    value === "fireflies" ||
    value === "linear" ||
    value === "claude_code" ||
    value === "github" ||
    value === "claude_session"
  );
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

function isLinearConnectBody(value: unknown): value is LinearConnectBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<LinearConnectBody>;
  return body.provider === "linear" && isNonEmptyString(body.api_token);
}

function isClaudeCodeConnectBody(value: unknown): value is ClaudeCodeConnectBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<ClaudeCodeConnectBody>;
  return body.provider === "claude_code" && isNonEmptyString(body.token);
}

function isClaudeSessionConnectBody(value: unknown): value is ClaudeSessionConnectBody {
  if (!value || typeof value !== "object") return false;
  return (value as Partial<ClaudeSessionConnectBody>).provider === "claude_session";
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

export const GET = withAuth<ConnectionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("source_connections")
    .select("provider, status, display_name, last_success_at, last_error_at, config_json")
    .eq("workspace_id", req.params.id)
    .in("provider", ["slack", "fireflies", "linear", "github", "claude_session"]);
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
    const errorCode = error instanceof SlackProviderError
      ? error.code
      : "slack_channel_list_failed";
    return errorResponse(errorCode, 502, error, req.params.id);
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
  // No isGithubConnectBody: GitHub connects via the dedicated install-session
  // routes (github-install.ts), not a pasted token here -- a "github" body
  // falls through every shape check below and correctly 400s as invalid_body.
  if (
    !isSlackConnectBody(body) &&
    !isFirefliesConnectBody(body) &&
    !isLinearConnectBody(body) &&
    !isClaudeCodeConnectBody(body) &&
    !isClaudeSessionConnectBody(body)
  ) {
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

  if (body.provider === "claude_session") {
    // No credential, no webhook -- just a status flip on the same
    // connection_key materialize-summary.ts auto-creates.
    try {
      await upsertSourceConnection(serviceClient, {
        workspace_id: req.params.id,
        provider: "claude_session",
        connection_key: CLAUDE_SESSION_CONNECTION_KEY,
        status: "active",
        connected_by_user_id: caller.userId,
      });
    } catch (err) {
      return errorResponse("connection_upsert_failed", 500, err, req.params.id);
    }
    return Response.json({ ok: true });
  }

  const isFireflies = body.provider === "fireflies";
  const isSlack = body.provider === "slack";
  const isLinear = body.provider === "linear";

  const { data: existing, error: existingError } = await serviceClient
    .from("source_connections")
    .select("id, credential_id, connection_key")
    .eq("workspace_id", req.params.id)
    .eq("provider", body.provider)
    .maybeSingle();
  if (existingError) return errorResponse("connection_lookup_failed", 500, existingError, req.params.id);

  // Needed before the webhookCreate call below, since the URL embeds it.
  const connectionKey = existing?.connection_key ?? randomUUID();

  let webhookSecret: string | undefined;
  let plaintext: string;
  if (body.provider === "fireflies") {
    webhookSecret = randomBytes(32).toString("hex");
    plaintext = JSON.stringify({ api_token: body.api_token, webhook_secret: webhookSecret });
  } else if (body.provider === "slack") {
    try {
      await joinPublicSlackChannels(body.bot_token, body.channel_ids);
    } catch (error) {
      const errorCode = error instanceof SlackProviderError
        ? error.code
        : "slack_channel_join_failed";
      return errorResponse(errorCode, 502, error, req.params.id);
    }
    plaintext = JSON.stringify({ bot_token: body.bot_token, app_token: body.app_token });
  } else if (body.provider === "linear") {
    webhookSecret = randomBytes(32).toString("hex");
    try {
      const webhookUrl = `${config.apiBaseUrl}/webhooks/linear/${connectionKey}`;
      await createLinearWebhook(body.api_token, webhookUrl, webhookSecret);
    } catch (error) {
      const errorCode = error instanceof LinearProviderError
        ? error.code
        : "linear_webhook_create_failed";
      return errorResponse(errorCode, 502, error, req.params.id);
    }
    plaintext = JSON.stringify({ api_token: body.api_token, webhook_secret: webhookSecret });
  } else {
    return errorResponse("unsupported_provider", 400);
  }
  const encrypted = encryptCredentialPayload(plaintext, CURRENT_CREDENTIAL_KEY_VERSION);

  let connectionId: string;

  if (existing) {
    connectionId = existing.id;

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
    } else if (isLinear) {
      // Webhooks only -- no reconciliation/polling backstop for Linear.
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
  if (isLinear) {
    return Response.json({ ok: true } satisfies LinearConnectResponse);
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
    const errorCode = error instanceof SlackProviderError
      ? error.code
      : "slack_channel_join_failed";
    return errorResponse(errorCode, 502, error, req.params.id);
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

  const { data, error } = await serviceClient.rpc("disconnect_source_connection", {
    p_workspace_id: req.params.id,
    p_provider: req.params.provider,
  });
  if (error) return errorResponse("disconnect_failed", 500, error, req.params.id);

  const result = (Array.isArray(data) ? data[0] : data) as {
    connection_id: string | null;
    transitioned: boolean;
  } | null;

  if (req.params.provider === "slack" && result?.transitioned && result.connection_id) {
    await stopSlackListener(result.connection_id);
  }

  return Response.json({ ok: true });
});

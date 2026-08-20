import { randomBytes, randomUUID } from "node:crypto";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import {
  CURRENT_CREDENTIAL_KEY_VERSION,
  decryptCredentialPayload,
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
  reconcileSlackChannels,
  SlackProviderError,
} from "../ingestion/slack/provider";
import {
  createLinearWebhook,
  deleteLinearWebhook,
  LinearProviderError,
} from "../ingestion/linear/provider";
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

interface SlackMembershipResponse {
  ok: boolean;
  channel_ids: string[];
  joined: string[];
  left: string[];
  failed: Array<{
    channel_id: string;
    operation: "join" | "leave";
    code: "slack_channel_join_failed" | "slack_channel_leave_failed";
  }>;
}

interface FirefliesConnectResponse {
  ok: true;
  webhookUrl: string;
  webhookSecret: string;
}

interface LinearConnectResponse {
  ok: true;
  cleanup_pending?: true;
}

const config = loadConfig();
const MAX_SLACK_RECONCILE_ATTEMPTS = 3;
const SINGLETON_CONNECTION_PROVIDERS = [
  "slack",
  "fireflies",
  "linear",
  "github",
  "claude_session",
] as const;

type ListedConnectionRow = Pick<
  SourceConnectionRow,
  | "id"
  | "provider"
  | "status"
  | "display_name"
  | "last_success_at"
  | "last_error_at"
  | "config_json"
  | "updated_at"
>;

function connectionSelectionRank(status: SourceConnectionRow["status"]): number {
  if (status === "active" || status === "degraded") return 0;
  if (status === "pending" || status === "error") return 1;
  if (status === "revoked") return 2;
  return 3;
}

function preferredConnection(
  current: ListedConnectionRow | undefined,
  candidate: ListedConnectionRow,
): ListedConnectionRow {
  if (!current) return candidate;
  const rankDifference = connectionSelectionRank(candidate.status) - connectionSelectionRank(current.status);
  if (rankDifference !== 0) return rankDifference < 0 ? candidate : current;
  const updatedDifference = (candidate.updated_at ?? "").localeCompare(current.updated_at ?? "");
  if (updatedDifference !== 0) return updatedDifference > 0 ? candidate : current;
  return candidate.id.localeCompare(current.id) > 0 ? candidate : current;
}

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
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
    .select("id, provider, status, display_name, last_success_at, last_error_at, config_json, updated_at")
    .eq("workspace_id", req.params.id)
    .in("provider", [...SINGLETON_CONNECTION_PROVIDERS]);
  if (error) return errorResponse("lookup_failed", 500, error, req.params.id);

  const selectedByProvider = new Map<string, ListedConnectionRow>();
  for (const connection of (data ?? []) as ListedConnectionRow[]) {
    selectedByProvider.set(
      connection.provider,
      preferredConnection(selectedByProvider.get(connection.provider), connection),
    );
  }

  const connections: Array<{
    provider: string;
    status: string | null;
    display_name: string | null;
    last_success_at: string | null;
    last_error_at: string | null;
    channel_ids?: string[];
  }> = SINGLETON_CONNECTION_PROVIDERS.flatMap((provider) => {
    const connection = selectedByProvider.get(provider);
    if (!connection) return [];
    return [{
      provider: connection.provider,
      status: connection.status,
      display_name: connection.display_name,
      last_success_at: connection.last_success_at,
      last_error_at: connection.last_error_at,
      ...(connection.provider === "slack"
        ? {
            channel_ids: Array.isArray(connection.config_json?.channel_ids)
              ? connection.config_json.channel_ids.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          }
        : {}),
    }];
  });

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
    return Response.json({
      ok: true,
      channels,
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

  const { data: existing, error: existingError } = await serviceClient
    .from("source_connections")
    .select("id, credential_id, connection_key, config_json, updated_at")
    .eq("workspace_id", req.params.id)
    .eq("provider", body.provider)
    .maybeSingle();
  if (existingError) return errorResponse("connection_lookup_failed", 500, existingError, req.params.id);

  const connectionKey = existing?.connection_key ?? randomUUID();

  if (body.provider === "linear") {
    const existingConfig = existing?.config_json
      && typeof existing.config_json === "object"
      && !Array.isArray(existing.config_json)
      ? existing.config_json as Record<string, unknown>
      : {};
    const pendingWebhookIds = stringArray(existingConfig.linear_cleanup_pending_webhook_ids);
    let priorApiToken: string | null = null;

    if (existing?.credential_id) {
      const { data: priorCredential, error: priorCredentialError } = await serviceClient
        .from("credentials")
        .select("encrypted_payload, encryption_key_version")
        .eq("id", existing.credential_id)
        .eq("workspace_id", req.params.id)
        .maybeSingle();
      if (priorCredentialError) {
        return errorResponse("credential_lookup_failed", 500, priorCredentialError, req.params.id);
      }
      if (priorCredential) {
        try {
          const parsed = JSON.parse(decryptCredentialPayload(
            priorCredential.encrypted_payload,
            priorCredential.encryption_key_version,
          )) as { api_token?: unknown };
          if (typeof parsed.api_token === "string" && parsed.api_token.length > 0) {
            priorApiToken = parsed.api_token;
          }
        } catch {
          priorApiToken = null;
        }
      }
    }

    const webhookSecret = randomBytes(32).toString("hex");
    const encrypted = encryptCredentialPayload(
      JSON.stringify({ api_token: body.api_token, webhook_secret: webhookSecret }),
      CURRENT_CREDENTIAL_KEY_VERSION,
    );
    let newWebhookId: string;
    try {
      const webhookUrl = `${config.apiBaseUrl}/webhooks/linear/${connectionKey}`;
      newWebhookId = (await createLinearWebhook(body.api_token, webhookUrl, webhookSecret)).id;
    } catch (error) {
      const errorCode = error instanceof LinearProviderError
        ? error.code
        : "linear_webhook_create_failed";
      return errorResponse(errorCode, 502, error, req.params.id);
    }

    const { data: commitData, error: commitError } = await serviceClient.rpc(
      "commit_linear_connection_swap",
      {
        p_workspace_id: req.params.id,
        p_expected_updated_at: existing?.updated_at ?? null,
        p_connection_key: connectionKey,
        p_encrypted_payload: encrypted,
        p_encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
        p_linear_webhook_id: newWebhookId,
        p_connected_by_user_id: caller.userId,
      },
    );
    if (commitError) {
      try {
        await deleteLinearWebhook(body.api_token, newWebhookId);
      } catch (cleanupError) {
        recordRouteError({
          workspaceId: req.params.id,
          operation: "auth",
          errorCode: "linear_webhook_compensation_failed",
          error: cleanupError,
          detail: { linear_webhook_id: newWebhookId },
        });
      }
      const conflict = (commitError as { message?: unknown }).message === "linear_connection_conflict";
      return errorResponse(
        conflict ? "linear_connection_conflict" : "linear_connection_commit_failed",
        conflict ? 409 : 500,
        commitError,
        req.params.id,
      );
    }

    const commit = commitData as {
      connection_id?: unknown;
      prior_webhook_id?: unknown;
      updated_at?: unknown;
    } | null;
    if (!commit || typeof commit.connection_id !== "string" || typeof commit.updated_at !== "string") {
      return errorResponse("linear_connection_commit_result_invalid", 500, undefined, req.params.id);
    }

    const priorWebhookId = typeof commit.prior_webhook_id === "string"
      ? commit.prior_webhook_id
      : null;
    const cleanupCandidates = [...new Set([
      ...(priorWebhookId ? [priorWebhookId] : []),
      ...pendingWebhookIds,
    ])].filter((webhookId) => webhookId !== newWebhookId);
    const cleanupPending: string[] = [];
    for (const webhookId of cleanupCandidates) {
      if (!priorApiToken) {
        cleanupPending.push(webhookId);
        continue;
      }
      try {
        await deleteLinearWebhook(priorApiToken, webhookId);
      } catch (cleanupError) {
        cleanupPending.push(webhookId);
        recordRouteError({
          workspaceId: req.params.id,
          sourceConnectionId: commit.connection_id,
          operation: "auth",
          errorCode: "linear_webhook_cleanup_pending",
          error: cleanupError,
        });
      }
    }

    let cleanupStateFailed = false;
    if (cleanupCandidates.length > 0) {
      const nextConfig: Record<string, unknown> = {
        ...existingConfig,
        linear_webhook_id: newWebhookId,
      };
      delete nextConfig.linear_cleanup_pending_webhook_ids;
      if (cleanupPending.length > 0) {
        nextConfig.linear_cleanup_pending_webhook_ids = cleanupPending;
      }
      const { data: cleanupState, error: cleanupStateError } = await serviceClient
        .from("source_connections")
        .update({
          config_json: nextConfig,
          ...(cleanupPending.length > 0
            ? { status: "degraded", last_error_at: new Date().toISOString() }
            : {}),
        })
        .eq("id", commit.connection_id)
        .eq("workspace_id", req.params.id)
        .eq("updated_at", commit.updated_at)
        .select("id")
        .maybeSingle();
      if (cleanupStateError || !cleanupState) {
        cleanupStateFailed = true;
        recordRouteError({
          workspaceId: req.params.id,
          sourceConnectionId: commit.connection_id,
          operation: "auth",
          errorCode: "linear_cleanup_state_failed",
          error: cleanupStateError ?? "linear_cleanup_state_conflict",
        });
      }
    }

    return Response.json({
      ok: true,
      ...(cleanupPending.length > 0 || cleanupStateFailed ? { cleanup_pending: true as const } : {}),
    } satisfies LinearConnectResponse);
  }

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
  } else {
    return errorResponse("unsupported_provider", 400);
  }
  const encrypted = encryptCredentialPayload(plaintext, CURRENT_CREDENTIAL_KEY_VERSION);

  let connectionId: string;

  if (existing && body.provider === "fireflies") {
    const { data: rotationData, error: rotationError } = await serviceClient.rpc(
      "rotate_fireflies_connection_credential",
      {
        p_workspace_id: req.params.id,
        p_connection_id: existing.id,
        p_encrypted_payload: encrypted,
        p_encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
        p_connected_by_user_id: caller.userId,
      },
    );
    if (rotationError) {
      return errorResponse("connection_update_failed", 500, rotationError, req.params.id);
    }
    const rotation = rotationData as { connection_id?: unknown } | null;
    if (!rotation || rotation.connection_id !== existing.id) {
      return errorResponse("connection_update_failed", 500, "invalid_rotation_result", req.params.id);
    }
    connectionId = existing.id;
  } else if (existing) {
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

  const desiredChannelIds = (body as { channel_ids: string[] }).channel_ids;
  let botToken: string | null = null;

  for (let attempt = 0; attempt < MAX_SLACK_RECONCILE_ATTEMPTS; attempt += 1) {
    const { data: connection, error: connectionError } = await serviceClient
      .from("source_connections")
      .select("id, config_json, updated_at")
      .eq("workspace_id", req.params.id)
      .eq("provider", "slack")
      .in("status", ["active", "degraded"])
      .maybeSingle();
    if (connectionError) {
      return errorResponse("connection_lookup_failed", 500, connectionError, req.params.id);
    }
    if (!connection) return errorResponse("not_found", 404);

    if (!botToken) {
      try {
        const credential = await resolveProviderCredential(req.params.id, "slack", serviceClient);
        botToken = credential.bot_token;
      } catch (error) {
        const errorCode = error instanceof SlackProviderError
          ? error.code
          : "slack_channel_reconcile_failed";
        return errorResponse(errorCode, 502, error, req.params.id);
      }
    }

    const reconciliation = await reconcileSlackChannels(
      botToken,
      stringArray(connection.config_json?.channel_ids),
      desiredChannelIds,
    );
    const existingConfig = connection.config_json
      && typeof connection.config_json === "object"
      && !Array.isArray(connection.config_json)
      ? connection.config_json
      : {};
    const { data: updatedConnection, error: updateError } = await serviceClient
      .from("source_connections")
      .update({
        config_json: { ...existingConfig, channel_ids: reconciliation.channelIds },
      })
      .eq("id", connection.id)
      .eq("workspace_id", req.params.id)
      .eq("updated_at", connection.updated_at)
      .in("status", ["active", "degraded"])
      .select("id")
      .maybeSingle();
    if (updateError) return errorResponse("connection_update_failed", 500, updateError, req.params.id);
    if (!updatedConnection) continue;

    return Response.json({
      ok: reconciliation.failed.length === 0,
      channel_ids: reconciliation.channelIds,
      joined: reconciliation.joined,
      left: reconciliation.left,
      failed: reconciliation.failed.map((failure) => ({
        channel_id: failure.channelId,
        operation: failure.operation,
        code: failure.code,
      })),
    } satisfies SlackMembershipResponse);
  }

  return errorResponse("connection_update_conflict", 409);
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

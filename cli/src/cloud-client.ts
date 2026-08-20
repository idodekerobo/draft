// cloud-client.ts — CLI-scoped auth store + hosted API access
//
// Wraps draft-core/auth-state (bound to ~/.draft/personal/cli-auth.json,
// isolated from desktop's auth.json) and draft-core/device-pairing behind
// helpers the auth/context commands share. Protected commands call
// requireAccessToken() first — it never prompts, never starts pairing, and
// returns a typed failure instead.

import {
  AuthLockError,
  AuthRefreshError,
  clearCliAuthState,
  getFreshCliAccessToken,
  readCliAuthState,
  writeCliAuthState,
  type AuthState,
} from "draft-core/auth-state";
import { getCliRuntimeConfig } from "./runtime-config.ts";

export interface WhoamiBody {
  organization_id: string | null;
  primary_team_id: string | null;
  workspace_id: string | null;
  onboarding_completed_at: string | null;
}

export type AccessTokenResult =
  | { ok: true; token: string }
  | { ok: false; code: "not_authenticated" | "auth_busy" | "session_refresh_transient" };

/** Never prompts and never starts a pairing flow — callers surface a typed failure instead. */
export async function requireAccessToken(): Promise<AccessTokenResult> {
  const initial = readCliAuthState();
  if (!initial) return { ok: false, code: "not_authenticated" };

  const config = getCliRuntimeConfig();
  try {
    const token = await getFreshCliAccessToken({ supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey });
    return { ok: true, token };
  } catch (error) {
    if (error instanceof AuthLockError) return { ok: false, code: "auth_busy" };
    if (error instanceof AuthRefreshError) {
      if (error.kind === "terminal") {
        if (sameStoredAuthLineage(readCliAuthState(), initial)) clearCliAuthState();
        return { ok: false, code: "not_authenticated" };
      }
      return { ok: false, code: "session_refresh_transient" };
    }
    if (error instanceof Error && error.message === "not_signed_in") return { ok: false, code: "not_authenticated" };
    return { ok: false, code: "session_refresh_transient" };
  }
}

export async function fetchWhoami(token: string): Promise<Response> {
  const config = getCliRuntimeConfig();
  return fetch(`${config.apiBaseUrl}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
}

export interface HydratedIdentity {
  organization_id: string | null;
  team_id: string | null;
  workspace_id: string | null;
  onboarding_completed_at: string | null;
}

export type WhoamiResult =
  | { ok: true; identity: HydratedIdentity }
  | { ok: false; code: "not_authenticated" | "auth_busy" | "session_refresh_transient" | "whoami_failed" };

type IdentityErrorCode = Extract<WhoamiResult, { ok: false }>["code"];
type AuthedWorkspaceResult =
  | { ok: true; token: string; workspaceId: string | null; identity: HydratedIdentity }
  | { ok: false; code: IdentityErrorCode };

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseWhoami(value: unknown): HydratedIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    !nullableString(body.organization_id) ||
    !nullableString(body.primary_team_id) ||
    !nullableString(body.workspace_id) ||
    !nullableString(body.onboarding_completed_at)
  ) return null;
  return {
    organization_id: body.organization_id,
    team_id: body.primary_team_id,
    workspace_id: body.workspace_id,
    onboarding_completed_at: body.onboarding_completed_at,
  };
}

function sameAuthLineage(
  current: AuthState | null,
  captured: AuthState | null,
  token: string,
): current is AuthState {
  return !!captured &&
    sameStoredAuthLineage(current, captured) &&
    captured.access_token === token &&
    current.access_token === token;
}

function sameStoredAuthLineage(
  current: AuthState | null,
  captured: AuthState | null,
): current is AuthState {
  return !!current &&
    !!captured &&
    current.access_token === captured.access_token &&
    current.refresh_token === captured.refresh_token;
}

async function resolveAuthedWorkspace(): Promise<AuthedWorkspaceResult> {
  const tokenResult = await requireAccessToken();
  if (!tokenResult.ok) return tokenResult;
  const captured = readCliAuthState();

  let response: Response;
  try {
    response = await fetchWhoami(tokenResult.token);
  } catch {
    return { ok: false, code: "session_refresh_transient" };
  }
  if (response.status === 401 || response.status === 403) {
    if (sameAuthLineage(readCliAuthState(), captured, tokenResult.token)) clearCliAuthState();
    return { ok: false, code: "not_authenticated" };
  }
  if (!response.ok) return { ok: false, code: "whoami_failed" };

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { ok: false, code: "whoami_failed" };
  }
  const identity = parseWhoami(value);
  if (!identity) return { ok: false, code: "whoami_failed" };

  const current = readCliAuthState();
  if (sameAuthLineage(current, captured, tokenResult.token)) {
    writeCliAuthState({
      ...current,
      organization_id: identity.organization_id,
      team_id: identity.team_id,
      workspace_id: identity.workspace_id,
      identity_resolved: true,
      onboarding_completed_at: identity.onboarding_completed_at,
    });
  }

  return { ok: true, token: tokenResult.token, workspaceId: identity.workspace_id, identity };
}

/** Always calls the hosted API live — cached identity is never authoritative on its own. */
export async function refreshIdentity(): Promise<WhoamiResult> {
  const result = await resolveAuthedWorkspace();
  return result.ok ? { ok: true, identity: result.identity } : result;
}

export interface WorkspaceDocument {
  content: string;
  sha256?: string;
}

export interface WorkspaceContextSnapshot {
  versionId: string;
  versionNumber: number;
  contentHash: string;
  creationReason: string;
  createdAt: string;
  documents: Record<string, WorkspaceDocument>;
}

export type ContextFetchResult =
  | { ok: true; snapshot: WorkspaceContextSnapshot }
  | { ok: false; code: "not_authenticated" | "auth_busy" | "session_refresh_transient" | "whoami_failed" | "no_workspace" | "context_fetch_failed" };

export async function fetchWorkspaceContext(): Promise<ContextFetchResult> {
  const resolved = await resolveAuthedWorkspace();
  if (!resolved.ok) return resolved;
  if (!resolved.workspaceId) return { ok: false, code: "no_workspace" };

  const config = getCliRuntimeConfig();
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/workspaces/${encodeURIComponent(resolved.workspaceId)}/context`, {
      headers: { Authorization: `Bearer ${resolved.token}` },
    });
  } catch {
    return { ok: false, code: "session_refresh_transient" };
  }
  if (response.status === 404) {
    return { ok: true, snapshot: { versionId: "", versionNumber: 0, contentHash: "", creationReason: "", createdAt: "", documents: {} } };
  }
  if (!response.ok) return { ok: false, code: "context_fetch_failed" };

  const body = await response.json() as Partial<WorkspaceContextSnapshot>;
  return {
    ok: true,
    snapshot: {
      versionId: body.versionId ?? "",
      versionNumber: body.versionNumber ?? 0,
      contentHash: body.contentHash ?? "",
      creationReason: body.creationReason ?? "",
      createdAt: body.createdAt ?? "",
      documents: body.documents ?? {},
    },
  };
}

export interface SessionListItem {
  id: string;
  provider: string;
  verified: boolean;
  display: string | null;
  project: string | null;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary_status: string;
  has_summary: boolean;
}

export type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FetchErrorCode };

export type FetchErrorCode =
  | "not_authenticated"
  | "auth_busy"
  | "session_refresh_transient"
  | "whoami_failed"
  | "no_workspace"
  | "request_failed"
  | "malformed_response"
  | "not_supported"
  | "not_found"
  | "linear_webhook_create_failed"
  | "slack_channel_list_failed"
  | "slack_channel_join_failed"
  | "slack_channel_leave_failed"
  | "github_installation_conflict"
  | "connection_update_conflict";

async function authedFetch(path: string, init?: RequestInit): Promise<{ ok: true; token: string; workspaceId: string; response: Response } | { ok: false; code: FetchErrorCode }> {
  const resolved = await resolveAuthedWorkspace();
  if (!resolved.ok) return resolved;
  if (!resolved.workspaceId) return { ok: false, code: "no_workspace" };

  const config = getCliRuntimeConfig();
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${resolved.token}`);
    response = await fetch(`${config.apiBaseUrl}/workspaces/${encodeURIComponent(resolved.workspaceId)}${path}`, {
      ...init,
      headers,
    });
  } catch {
    return { ok: false, code: "session_refresh_transient" };
  }
  return { ok: true, token: resolved.token, workspaceId: resolved.workspaceId, response };
}

export type BackendProvider = "github" | "slack" | "linear" | "fireflies" | "claude_code";
export type BackendConnectionProvider = BackendProvider | "claude_session";
export type BackendConnectionStatus = "pending" | "active" | "degraded" | "error" | "revoked" | "expired";

export interface HostedConnectionTransport {
  provider: BackendConnectionProvider;
  status: BackendConnectionStatus | null;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  channel_ids?: string[];
}

export type HostedConnectBody =
  | { provider: "fireflies"; api_token: string }
  | { provider: "linear"; api_token: string }
  | { provider: "slack"; bot_token: string; app_token: string; channel_ids: string[] }
  | { provider: "claude_code"; token: string };

export type ConnectIntegrationResult =
  | { ok: true }
  | { ok: true; cleanup_pending: true }
  | { ok: true; webhookUrl: string; webhookSecret: string };

export interface GithubInstallSession {
  code: string;
  installUrl: string;
}

export interface HostedSlackChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

export interface SlackMembershipFailure {
  channel_id: string;
  operation: "join" | "leave";
  code: "slack_channel_join_failed" | "slack_channel_leave_failed";
}

export interface SlackMembershipReconcileResult {
  ok: boolean;
  channel_ids: string[];
  joined: string[];
  left: string[];
  failed: SlackMembershipFailure[];
}

const SAFE_BACKEND_ERROR_CODES = new Set<FetchErrorCode>([
  "not_supported",
  "not_found",
  "linear_webhook_create_failed",
  "slack_channel_list_failed",
  "slack_channel_join_failed",
  "slack_channel_leave_failed",
  "github_installation_conflict",
  "connection_update_conflict",
]);
const BACKEND_PROVIDERS = new Set<BackendConnectionProvider>([
  "github",
  "slack",
  "linear",
  "fireflies",
  "claude_code",
  "claude_session",
]);
const BACKEND_CONNECTION_STATUSES = new Set<BackendConnectionStatus>([
  "pending",
  "active",
  "degraded",
  "error",
  "revoked",
  "expired",
]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArrayValue(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function safeBackendError(value: unknown): FetchErrorCode | null {
  const body = recordValue(value);
  return typeof body?.error === "string" && SAFE_BACKEND_ERROR_CODES.has(body.error as FetchErrorCode)
    ? body.error as FetchErrorCode
    : null;
}

async function requestValue<T>(
  path: string,
  init: RequestInit | undefined,
  decode: (value: unknown) => T | null,
): Promise<FetchResult<T>> {
  const result = await authedFetch(path, init);
  if (!result.ok) return result;

  let value: unknown;
  try {
    value = await result.response.json();
  } catch {
    return { ok: false, code: result.response.ok ? "malformed_response" : "request_failed" };
  }
  if (!result.response.ok) {
    return { ok: false, code: safeBackendError(value) ?? "request_failed" };
  }
  const decoded = decode(value);
  return decoded === null
    ? { ok: false, code: "malformed_response" }
    : { ok: true, value: decoded };
}

function decodeConnection(value: unknown): HostedConnectionTransport | null {
  const row = recordValue(value);
  if (
    !row ||
    typeof row.provider !== "string" ||
    !BACKEND_PROVIDERS.has(row.provider as BackendConnectionProvider) ||
    !(row.status === null || (
      typeof row.status === "string" &&
      BACKEND_CONNECTION_STATUSES.has(row.status as BackendConnectionStatus)
    )) ||
    !nullableString(row.display_name) ||
    !nullableString(row.last_success_at) ||
    !nullableString(row.last_error_at)
  ) return null;

  const connection: HostedConnectionTransport = {
    provider: row.provider as BackendConnectionProvider,
    status: row.status as BackendConnectionStatus | null,
    display_name: row.display_name,
    last_success_at: row.last_success_at,
    last_error_at: row.last_error_at,
  };
  if (connection.provider === "slack") {
    const channelIds = stringArrayValue(row.channel_ids);
    if (!channelIds) return null;
    connection.channel_ids = channelIds;
  }
  return connection;
}

function decodeOk(value: unknown): { ok: true } | null {
  const body = recordValue(value);
  return body?.ok === true ? { ok: true } : null;
}

function connectRequestBody(body: HostedConnectBody): HostedConnectBody {
  switch (body.provider) {
    case "fireflies":
    case "linear":
      return { provider: body.provider, api_token: body.api_token };
    case "slack":
      return {
        provider: "slack",
        bot_token: body.bot_token,
        app_token: body.app_token,
        channel_ids: [...body.channel_ids],
      };
    case "claude_code":
      return { provider: "claude_code", token: body.token };
  }
}

export function listConnections(): Promise<FetchResult<{ connections: HostedConnectionTransport[] }>> {
  return requestValue("/connections", undefined, (value) => {
    const body = recordValue(value);
    if (!body || !Array.isArray(body.connections)) return null;
    const connections: HostedConnectionTransport[] = [];
    for (const raw of body.connections) {
      const connection = decodeConnection(raw);
      if (!connection) return null;
      connections.push(connection);
    }
    return { connections };
  });
}

export function connectIntegration(body: HostedConnectBody): Promise<FetchResult<ConnectIntegrationResult>> {
  return requestValue("/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(connectRequestBody(body)),
  }, (value) => {
    const response = recordValue(value);
    if (response?.ok !== true) return null;
    if (body.provider === "fireflies") {
      return typeof response.webhookUrl === "string" && response.webhookUrl.length > 0 &&
        typeof response.webhookSecret === "string" && response.webhookSecret.length > 0
        ? { ok: true, webhookUrl: response.webhookUrl, webhookSecret: response.webhookSecret }
        : null;
    }
    if (body.provider === "linear") {
      if (response.cleanup_pending === undefined) return { ok: true };
      return response.cleanup_pending === true ? { ok: true, cleanup_pending: true } : null;
    }
    return { ok: true };
  });
}

export function disconnectIntegration(provider: BackendProvider): Promise<FetchResult<{ ok: true }>> {
  return requestValue(`/connections/${encodeURIComponent(provider)}`, { method: "DELETE" }, decodeOk);
}

export function createGithubInstallSession(): Promise<FetchResult<GithubInstallSession>> {
  return requestValue("/github/install-sessions", { method: "POST" }, (value) => {
    const body = recordValue(value);
    if (!body || typeof body.code !== "string" || body.code.length === 0 || typeof body.installUrl !== "string") {
      return null;
    }
    try {
      const url = new URL(body.installUrl);
      if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    } catch {
      return null;
    }
    return { code: body.code, installUrl: body.installUrl };
  });
}

export function listSlackChannels(): Promise<FetchResult<{ ok: true; channels: HostedSlackChannel[] }>> {
  return requestValue("/connections/slack/channels", undefined, (value) => {
    const body = recordValue(value);
    if (body?.ok !== true || !Array.isArray(body.channels)) return null;
    const channels: HostedSlackChannel[] = [];
    for (const raw of body.channels) {
      const channel = recordValue(raw);
      if (
        !channel ||
        typeof channel.id !== "string" ||
        typeof channel.name !== "string" ||
        typeof channel.memberCount !== "number" ||
        !Number.isFinite(channel.memberCount) ||
        typeof channel.isMember !== "boolean"
      ) return null;
      channels.push({
        id: channel.id,
        name: channel.name,
        memberCount: channel.memberCount,
        isMember: channel.isMember,
      });
    }
    return { ok: true, channels };
  });
}

export function setSlackChannels(channelIds: string[]): Promise<FetchResult<SlackMembershipReconcileResult>> {
  return requestValue("/connections/slack", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_ids: channelIds }),
  }, (value) => {
    const body = recordValue(value);
    if (!body || typeof body.ok !== "boolean") return null;
    const persisted = stringArrayValue(body.channel_ids);
    const joined = stringArrayValue(body.joined);
    const left = stringArrayValue(body.left);
    if (!persisted || !joined || !left || !Array.isArray(body.failed)) return null;
    const failed: SlackMembershipFailure[] = [];
    for (const raw of body.failed) {
      const failure = recordValue(raw);
      if (!failure || (failure.operation !== "join" && failure.operation !== "leave")) return null;
      const expectedCode = failure.operation === "join"
        ? "slack_channel_join_failed"
        : "slack_channel_leave_failed";
      if (typeof failure.channel_id !== "string" || failure.code !== expectedCode) return null;
      failed.push({ channel_id: failure.channel_id, operation: failure.operation, code: expectedCode });
    }
    if (body.ok !== (failed.length === 0)) return null;
    return { ok: body.ok, channel_ids: persisted, joined, left, failed };
  });
}

export async function mintSessionIngestToken(label: string | null): Promise<FetchResult<{ id: string; token: string; workspaceId: string }>> {
  const result = await authedFetch("/sessions/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!result.ok) return result;
  if (!result.response.ok) return { ok: false, code: "request_failed" };
  const body = await result.response.json() as { id: string; token: string };
  return { ok: true, value: { id: body.id, token: body.token, workspaceId: result.workspaceId } };
}

export interface ListSessionsFilters {
  provider?: string;
  user?: string;
  since?: string;
}

export async function fetchSessions(filters: ListSessionsFilters = {}): Promise<FetchResult<SessionListItem[]>> {
  const query = new URLSearchParams();
  if (filters.provider) query.set("provider", filters.provider);
  if (filters.user) query.set("user", filters.user);
  if (filters.since) query.set("since", filters.since);
  const qs = query.toString();

  const result = await authedFetch(`/sessions${qs ? `?${qs}` : ""}`);
  if (!result.ok) return result;
  if (!result.response.ok) return { ok: false, code: "request_failed" };
  const body = await result.response.json() as { sessions: SessionListItem[] };
  return { ok: true, value: body.sessions };
}

export type SessionReadResult =
  | { kind: "summary"; summary: string | null; occurred_at?: string }
  | { kind: "transcript"; messages: { seq: number; role: string; content: string; created_at: string }[]; windows?: { start_seq: number; end_seq: number }[]; truncated_bytes?: number };

export interface ReadTranscriptOptions {
  grep?: string;
  context?: number;
  maxBytes?: number;
}

export async function fetchSessionRead(sessionId: string, mode: "summary" | "transcript", options: ReadTranscriptOptions = {}): Promise<FetchResult<SessionReadResult>> {
  const query = new URLSearchParams();
  query.set(mode, "");
  if (mode === "transcript") {
    if (options.grep) query.set("grep", options.grep);
    if (options.context) query.set("context", String(options.context));
    if (options.maxBytes) query.set("maxBytes", String(options.maxBytes));
  }
  const result = await authedFetch(`/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`);
  if (!result.ok) return result;
  if (result.response.status === 404) return { ok: false, code: "request_failed" };
  if (!result.response.ok) return { ok: false, code: "request_failed" };
  const body = await result.response.json() as {
    messages: { seq: number; role: string; content: string; created_at: string }[];
    windows?: { start_seq: number; end_seq: number }[];
    truncated_bytes?: number;
    summary: string | null;
    occurred_at?: string;
  };
  return mode === "transcript"
    ? { ok: true, value: { kind: "transcript", messages: body.messages, windows: body.windows, truncated_bytes: body.truncated_bytes } }
    : { ok: true, value: { kind: "summary", summary: body.summary, occurred_at: body.occurred_at } };
}

export interface SessionSearchItem {
  session_id: string;
  agent_session_id: string | null;
  provider: string | null;
  verified: boolean;
  display: string | null;
  occurred_at: string;
  snippet: string;
}

export interface SearchSessionsFilters {
  q: string;
  provider?: string;
  user?: string;
  since?: string;
}

export async function fetchSessionsSearch(filters: SearchSessionsFilters): Promise<FetchResult<SessionSearchItem[]>> {
  const query = new URLSearchParams();
  query.set("q", filters.q);
  if (filters.provider) query.set("provider", filters.provider);
  if (filters.user) query.set("user", filters.user);
  if (filters.since) query.set("since", filters.since);

  const result = await authedFetch(`/sessions/search?${query.toString()}`);
  if (!result.ok) return result;
  if (!result.response.ok) return { ok: false, code: "request_failed" };
  const body = await result.response.json() as { sessions: SessionSearchItem[] };
  return { ok: true, value: body.sessions };
}

const DIMENSION_INDEX_PATTERN = /^([^/]+)\/index\.md$/;

export function discoverDimensions(documents: Record<string, WorkspaceDocument>): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const path of Object.keys(documents)) {
    const match = DIMENSION_INDEX_PATTERN.exec(path);
    if (match) found.push({ name: match[1], path });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

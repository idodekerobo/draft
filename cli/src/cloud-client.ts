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
  const state = readCliAuthState();
  if (!state) return { ok: false, code: "not_authenticated" };

  const config = getCliRuntimeConfig();
  try {
    const token = await getFreshCliAccessToken({ supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey });
    return { ok: true, token };
  } catch (error) {
    if (error instanceof AuthLockError) return { ok: false, code: "auth_busy" };
    if (error instanceof AuthRefreshError) {
      if (error.kind === "terminal") {
        clearCliAuthState();
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

/** Always calls the hosted API live — cached identity is never authoritative on its own. */
export async function refreshIdentity(): Promise<WhoamiResult> {
  const tokenResult = await requireAccessToken();
  if (!tokenResult.ok) return tokenResult;

  let response: Response;
  try {
    response = await fetchWhoami(tokenResult.token);
  } catch {
    return { ok: false, code: "session_refresh_transient" };
  }
  if (response.status === 401 || response.status === 403) {
    clearCliAuthState();
    return { ok: false, code: "not_authenticated" };
  }
  if (!response.ok) return { ok: false, code: "whoami_failed" };

  const body = await response.json() as Partial<WhoamiBody>;
  const identity: HydratedIdentity = {
    organization_id: body.organization_id ?? null,
    team_id: body.primary_team_id ?? null,
    workspace_id: body.workspace_id ?? null,
    onboarding_completed_at: body.onboarding_completed_at ?? null,
  };

  const current = readCliAuthState();
  if (current) {
    const resolved: AuthState = {
      ...current,
      organization_id: identity.organization_id,
      team_id: identity.team_id,
      workspace_id: identity.workspace_id,
      identity_resolved: true,
      onboarding_completed_at: identity.onboarding_completed_at,
    };
    writeCliAuthState(resolved);
  }

  return { ok: true, identity };
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
  const tokenResult = await requireAccessToken();
  if (!tokenResult.ok) return tokenResult;

  const identityResult = await refreshIdentity();
  if (!identityResult.ok) return identityResult;
  if (!identityResult.identity.workspace_id) return { ok: false, code: "no_workspace" };

  const config = getCliRuntimeConfig();
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/workspaces/${encodeURIComponent(identityResult.identity.workspace_id)}/context`, {
      headers: { Authorization: `Bearer ${tokenResult.token}` },
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
  | { ok: false; code: "not_authenticated" | "auth_busy" | "session_refresh_transient" | "whoami_failed" | "no_workspace" | "request_failed" };

async function authedFetch(path: string, init?: RequestInit): Promise<{ ok: true; token: string; workspaceId: string; response: Response } | { ok: false; code: FetchResult<never>["code"] }> {
  const tokenResult = await requireAccessToken();
  if (!tokenResult.ok) return tokenResult;

  const identityResult = await refreshIdentity();
  if (!identityResult.ok) return identityResult;
  if (!identityResult.identity.workspace_id) return { ok: false, code: "no_workspace" };

  const config = getCliRuntimeConfig();
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}/workspaces/${encodeURIComponent(identityResult.identity.workspace_id)}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${tokenResult.token}` },
    });
  } catch {
    return { ok: false, code: "session_refresh_transient" };
  }
  return { ok: true, token: tokenResult.token, workspaceId: identityResult.identity.workspace_id, response };
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
  const body = await result.response.json();
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

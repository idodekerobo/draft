"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { documentsToEntries, type ContextFileEntry } from "draft-shared-ui/context-files";
import { IntegrationActionsProvider, type IntegrationActions, type TrackFn } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import type { Identity } from "@/lib/identity";

export type ContextState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; entries: ContextFileEntry[]; versionNumber: number; createdAt: string };

export interface ConnectionsState {
  status: "loading" | "ready" | "error";
  connections: unknown[];
  agentLastUsedAt: string | null;
}

interface WorkspaceValue {
  identity: Identity;
  workspaceId: string;
  orgName: string;
  context: ContextState;
  reloadContext: () => Promise<void>;
  connections: ConnectionsState;
  reloadConnections: () => Promise<boolean>;
  updatePrivacy: (patch: { analytics_consent?: boolean; session_replay_enabled?: boolean }) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  /** True when the context version is newer than the last one this browser showed. */
  hasUnseenContext: boolean;
  markContextSeen: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export const ORG_NAME_KEY = "draft.orgName";

function readOrgName(): string {
  try {
    return sessionStorage.getItem(ORG_NAME_KEY) || "your team";
  } catch {
    return "your team";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.status === 0 ? "Could not reach Draft. Check your connection and try again." : fallback;
  return fallback;
}

/** Loads context once per session and shares it with every page. */
export function WorkspaceProvider({ identity: initialIdentity, children }: { identity: Identity & { workspace_id: string }; children: ReactNode }) {
  const { track, syncUser } = useAnalytics();
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  const [orgName, setOrgName] = useState("your team");
  const [context, setContext] = useState<ContextState>({ status: "loading" });
  const [connections, setConnections] = useState<ConnectionsState>({ status: "loading", connections: [], agentLastUsedAt: null });
  const workspaceId = initialIdentity.workspace_id;
  const seenKey = `draft.seenContextVersion.${workspaceId}`;
  const [seenVersion, setSeenVersion] = useState<number | null>(null);

  useEffect(() => {
    setOrgName(readOrgName());
    try { setSeenVersion(Number(localStorage.getItem(seenKey) ?? 0)); } catch { setSeenVersion(0); }
  }, [seenKey]);

  const markContextSeen = useCallback(() => {
    if (context.status !== "ready") return;
    setSeenVersion(context.versionNumber);
    try { localStorage.setItem(seenKey, String(context.versionNumber)); } catch {}
  }, [context, seenKey]);
  const hasUnseenContext = context.status === "ready" && seenVersion !== null && context.versionNumber > seenVersion;
  useEffect(() => { syncUser(identity); }, [identity, syncUser]);

  const reloadContext = useCallback(async () => {
    try {
      const snapshot = await apiFetch<{ versionNumber: number; createdAt: string; documents: Record<string, { content: string }> }>(`/workspaces/${workspaceId}/context`);
      setContext({ status: "ready", entries: documentsToEntries(snapshot.documents), versionNumber: snapshot.versionNumber, createdAt: snapshot.createdAt });
    } catch (error) {
      setContext(error instanceof ApiError && error.code === "no_context_yet" ? { status: "empty" } : { status: "error" });
    }
  }, [workspaceId]);

  const reloadConnections = useCallback(async () => {
    try {
      const body = await apiFetch<{ connections: unknown[]; agent?: { last_used_at: string | null } }>(`/workspaces/${workspaceId}/connections`);
      setConnections({ status: "ready", connections: body.connections, agentLastUsedAt: body.agent?.last_used_at ?? null });
      return true;
    } catch {
      setConnections((current) => ({ ...current, status: "error" }));
      return false;
    }
  }, [workspaceId]);

  useEffect(() => {
    void reloadContext();
    void reloadConnections();
  }, [reloadContext, reloadConnections]);

  const updatePrivacy = useCallback(async (patch: { analytics_consent?: boolean; session_replay_enabled?: boolean }) => {
    const next = await apiFetch<Pick<Identity, "analytics_consent" | "analytics_consent_at" | "session_replay_enabled">>("/me/privacy", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setIdentity((current) => ({ ...current, ...next }));
    if (patch.analytics_consent === true) track("analytics_consent_granted", {});
  }, [track]);

  const completeOnboarding = useCallback(async () => {
    const body = await apiFetch<{ onboarding_completed_at: string }>("/onboarding-complete", { method: "POST" });
    setIdentity((current) => ({ ...current, onboarding_completed_at: body.onboarding_completed_at }));
  }, []);

  const integrationActions = useMemo<IntegrationActions>(() => {
    async function connect<T extends object>(body: object, fallback: string): Promise<T | { ok: false; error: string }> {
      try {
        return await apiFetch<T>(`/workspaces/${workspaceId}/connections`, { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        return { ok: false, error: errorMessage(error, fallback) };
      }
    }
    const unavailable = async () => ({ ok: false, error: "Use the Draft desktop app for this." });
    return {
      track: ((event: string, props: Record<string, unknown>) => {
        (track as (name: string, properties: Record<string, unknown>) => void)(event, props);
        if (event === "integration_connected" && !connections.connections.some((row) => (row as { is_mine?: boolean }).is_mine === true)) {
          track("first_tool_connected", { source: String(props.source) });
        }
      }) as TrackFn,
      openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
      connectFireflies: ({ apiKey }) => connect({ provider: "fireflies", api_token: apiKey.trim() }, "Could not connect Fireflies. Check your API key."),
      connectGranola: ({ apiKey, accountKind }) => connect({ provider: "granola", api_token: apiKey.trim(), account_kind: accountKind }, "Could not connect Granola. Check your API key."),
      connectLinear: ({ apiKey }) => connect({ provider: "linear", api_token: apiKey.trim() }, "Could not connect Linear. Check your API key."),
      // Slack's API blocks browsers, and folder actions need a desktop.
      getSlackManifestUrl: unavailable,
      listSlackChannels: unavailable,
      connectSlack: unavailable,
      updateSlackChannels: async () => ({ ok: false, channelIds: [], failed: [], error: "Use the Draft desktop app for this." }),
      connectSessionTracking: unavailable,
      selectSessionRepoFolder: async () => ({}),
      enableSessionCaptureForRepo: unavailable,
    };
  }, [workspaceId, track, connections.connections]);

  const value = useMemo<WorkspaceValue>(() => ({
    identity, workspaceId, orgName, context, reloadContext, connections, reloadConnections, updatePrivacy, completeOnboarding, hasUnseenContext, markContextSeen,
  }), [identity, workspaceId, orgName, context, reloadContext, connections, reloadConnections, updatePrivacy, completeOnboarding, hasUnseenContext, markContextSeen]);

  return (
    <WorkspaceContext.Provider value={value}>
      <IntegrationActionsProvider actions={integrationActions}>{children}</IntegrationActionsProvider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is required");
  return value;
}

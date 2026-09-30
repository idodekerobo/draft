"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { IntegrationActionsProvider, queryKeys, useQueryClient, type IntegrationActions, type TrackFn } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import type { Identity } from "@/lib/identity";
import type { ConnectionsBody } from "@/lib/queries";

interface WorkspaceValue {
  identity: Identity;
  workspaceId: string;
  orgName: string;
  updatePrivacy: (patch: { analytics_consent?: boolean; session_replay_enabled?: boolean }) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  /** Last context version this browser showed. Null until read from storage. */
  seenContextVersion: number | null;
  markContextSeen: (versionNumber: number) => void;
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

/** Holds identity and stable actions. Server data lives in the query cache. */
export function WorkspaceProvider({ identity: initialIdentity, children }: { identity: Identity & { workspace_id: string }; children: ReactNode }) {
  const { track, syncUser } = useAnalytics();
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<Identity>(initialIdentity);
  const [orgName, setOrgName] = useState("your team");
  const workspaceId = initialIdentity.workspace_id;
  const seenKey = `draft.seenContextVersion.${workspaceId}`;
  const [seenContextVersion, setSeenContextVersion] = useState<number | null>(null);

  useEffect(() => {
    setOrgName(readOrgName());
    try { setSeenContextVersion(Number(localStorage.getItem(seenKey) ?? 0)); } catch { setSeenContextVersion(0); }
  }, [seenKey]);

  const markContextSeen = useCallback((versionNumber: number) => {
    setSeenContextVersion(versionNumber);
    try { localStorage.setItem(seenKey, String(versionNumber)); } catch {}
  }, [seenKey]);

  useEffect(() => { syncUser(identity); }, [identity, syncUser]);

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
    // Read at call time so a connections refetch does not rebuild these actions.
    function hasMyConnection(): boolean {
      const cached = queryClient.getQueryData<ConnectionsBody>(queryKeys.connections(workspaceId));
      return cached?.connections.some((row) => (row as { is_mine?: boolean }).is_mine === true) ?? false;
    }
    const unavailable = async () => ({ ok: false, error: "Use the Draft desktop app for this." });
    return {
      track: ((event: string, props: Record<string, unknown>) => {
        (track as (name: string, properties: Record<string, unknown>) => void)(event, props);
        if (event === "integration_connected" && !hasMyConnection()) {
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
      connectSessionTracking: () => connect<{ ok: true }>({ provider: "claude_session" }, "Could not turn on coding sessions."),
      selectSessionRepoFolder: async () => ({}),
      enableSessionCaptureForRepo: unavailable,
    };
  }, [workspaceId, track, queryClient]);

  const value = useMemo<WorkspaceValue>(() => ({
    identity, workspaceId, orgName, updatePrivacy, completeOnboarding, seenContextVersion, markContextSeen,
  }), [identity, workspaceId, orgName, updatePrivacy, completeOnboarding, seenContextVersion, markContextSeen]);

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

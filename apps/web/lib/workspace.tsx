"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { IntegrationActionsProvider, SessionViewStateProvider, queryKeys, useQueryClient, useWorkspaceDataSignals, type IntegrationActions, type SlackChannelsResult, type TrackFn } from "draft-shared-ui";
import { buildSlackManifestUrl, validateSlackTokenFormat } from "draft-core/integrations/slack-hosted";
import { folderOptionsFromBody, syncedFoldersFromBody } from "draft-core/integrations/google-drive-folders";
import { ApiError, apiFetch } from "@/lib/api";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { watchSignals } from "@/lib/live-sessions-api";
import type { Identity } from "@/lib/identity";
import type { ConnectionsBody } from "@/lib/queries";

interface WorkspaceValue {
  identity: Identity;
  workspaceId: string;
  orgName: string;
  updatePrivacy: (patch: { analytics_consent: boolean }) => Promise<void>;
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

  useEffect(() => { syncUser({ ...identity, workspace_id: workspaceId }); }, [identity, workspaceId, syncUser]);

  useWorkspaceDataSignals(watchSignals, workspaceId);

  const updatePrivacy = useCallback(async (patch: { analytics_consent: boolean }) => {
    const next = await apiFetch<Pick<Identity, "analytics_consent" | "analytics_consent_at">>("/me/privacy", {
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
      getSlackManifestUrl: async () => buildSlackManifestUrl(),
      // Slack's API refuses browser calls, so channels are listed through Draft's backend.
      listSlackChannels: async ({ botToken }) => {
        try {
          return botToken
            ? await apiFetch<SlackChannelsResult>(`/workspaces/${workspaceId}/connections/slack/channels`, { method: "POST", body: JSON.stringify({ bot_token: botToken }) })
            : await apiFetch<SlackChannelsResult>(`/workspaces/${workspaceId}/connections/slack/channels`);
        } catch (error) {
          return { ok: false, error: errorMessage(error, "Could not load Slack channels. Check the bot token.") };
        }
      },
      connectSlack: async ({ botToken, appToken, channelIds }) => {
        const format = validateSlackTokenFormat(botToken, appToken);
        if (!format.ok) return format;
        return connect({ provider: "slack", bot_token: botToken, app_token: appToken, channel_ids: channelIds }, "Could not connect Slack. Check both tokens.");
      },
      updateSlackChannels: async ({ channelIds }) => {
        try {
          const result = await apiFetch<{ ok: boolean; channel_ids: string[]; failed: Array<{ channel_id: string; operation: "join" | "leave" }> }>(
            `/workspaces/${workspaceId}/connections/slack`,
            { method: "PATCH", body: JSON.stringify({ channel_ids: channelIds }) },
          );
          return { ok: result.ok, channelIds: result.channel_ids, failed: result.failed.map((failure) => ({ channelId: failure.channel_id, operation: failure.operation })) };
        } catch (error) {
          return { ok: false, channelIds: [], failed: [], error: errorMessage(error, "Could not update Slack channels.") };
        }
      },
      startGoogleConnect: async (input) => {
        try {
          const body = await apiFetch<{ code: string; authUrl: string }>(`/workspaces/${workspaceId}/google/connect-sessions`, { method: "POST", body: JSON.stringify({ product: input?.product }) });
          return { ok: true, ...body };
        } catch (error) {
          return { ok: false, error: error instanceof ApiError ? error.code : undefined };
        }
      },
      pollGoogleConnect: async (code) => {
        const body = await apiFetch<{ status: "pending" | "connected" | "error"; errorMessage?: string }>(
          `/workspaces/${workspaceId}/google/connect-sessions/${encodeURIComponent(code)}`,
        );
        return { status: body.status, message: body.errorMessage };
      },
      listSyncedGoogleDriveFolders: async () => {
        try {
          return { ok: true, ...syncedFoldersFromBody(await apiFetch<unknown>(`/workspaces/${workspaceId}/google/drive-folders`)) };
        } catch (error) {
          return { ok: false, error: error instanceof ApiError ? error.code : undefined };
        }
      },
      listDriveFolderOptions: async ({ parent }) => {
        try {
          const body = await apiFetch<unknown>(`/workspaces/${workspaceId}/google/drive-folders/options?parent=${encodeURIComponent(parent)}`);
          return { ok: true, options: folderOptionsFromBody(body) };
        } catch (error) {
          return { ok: false, error: error instanceof ApiError ? error.code : undefined };
        }
      },
      addSyncedGoogleDriveFolder: async (input) => {
        try {
          await apiFetch<{ folder: Record<string, unknown> }>(`/workspaces/${workspaceId}/google/drive-folders`, { method: "POST", body: JSON.stringify(input) });
          return { ok: true };
        } catch (error) {
          if (!(error instanceof ApiError)) return { ok: false };
          const message = typeof error.detail?.message === "string" ? error.detail.message : undefined;
          return { ok: false, error: error.code, message };
        }
      },
      removeSyncedGoogleDriveFolder: async ({ id }) => {
        try {
          await apiFetch(`/workspaces/${workspaceId}/google/drive-folders/${encodeURIComponent(id)}`, { method: "DELETE" });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof ApiError ? error.code : undefined };
        }
      },
      // Folder actions need a desktop.
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
      <SessionViewStateProvider scope={`${identity.id}:${workspaceId}`}>
        <IntegrationActionsProvider actions={integrationActions}>{children}</IntegrationActionsProvider>
      </SessionViewStateProvider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is required");
  return value;
}

"use client";

import { useState, type ReactNode } from "react";
import {
  CodingSessionsPanel,
  DataBoundary,
  FirefliesConnectPanel,
  GithubConnectPanel,
  GoogleConnectPanel,
  GranolaConnectPanel,
  LinearConnectPanel,
  SlackConnectPanel,
  ToolList,
  AGENT_SETUP_PROMPT,
  codingSessionsStatus,
  mcpUrl,
  queryKeys,
  useIntegrationActions,
  useQuery,
  useRefreshQuery,
  useSuspenseQuery,
  type ManagePanel,
  type TeamSessionReposState,
  type ToolGroup,
  type ToolId,
} from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { API_URL } from "@/lib/config";
import { connectionsQueryOptions, sessionReposQueryOptions } from "@/lib/queries";
import { webToolStatuses } from "@/lib/tool-statuses";
import { useGithubInstall } from "@/lib/use-github-install";
import { useWorkspace } from "@/lib/workspace";

function DisconnectButton({ provider, query = "" }: { provider: "fireflies" | "granola" | "github" | "slack" | "gmail"; query?: string }) {
  const { workspaceId } = useWorkspace();
  const reloadConnections = useRefreshQuery(queryKeys.connections(workspaceId));
  const { track } = useIntegrationActions();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function disconnect() {
    setBusy(true);
    setFailed(false);
    try {
      await apiFetch(`/workspaces/${workspaceId}/connections/${provider}${query}`, { method: "DELETE" });
      track("integration_disconnected", { source: provider });
      await reloadConnections();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="ui-btn" onClick={() => void disconnect()} disabled={busy}>
      {busy ? "Disconnecting…" : failed ? "Try again" : "Disconnect"}
    </button>
  );
}

function GithubPanel({ onDone }: { onDone: () => void }) {
  const { workspaceId } = useWorkspace();
  const { track } = useIntegrationActions();
  const reloadConnections = useRefreshQuery(queryKeys.connections(workspaceId));
  const { phase, error, connect } = useGithubInstall(workspaceId, async () => {
    track("integration_connected", { source: "github" });
    await reloadConnections();
    onDone();
  });
  return (
    <GithubConnectPanel detail={undefined} classPrefix="ui-panel" phase={phase} error={error} onConnected={onDone} onConnect={connect} />
  );
}

const DEFAULT_UNAVAILABLE_HINT = "Ask your admin to connect this in the Draft desktop app.";

/** Web connects every hosted tool and coding sessions. */
function WebToolListBody({ groups, allowDisconnect, unavailableHint, only }: { groups?: ToolGroup[]; allowDisconnect: boolean; unavailableHint: string; only?: ToolId }) {
  const { workspaceId } = useWorkspace();
  const { data: connections } = useSuspenseQuery(connectionsQueryOptions(workspaceId, apiFetch));
  const reposQuery = useQuery(sessionReposQueryOptions(workspaceId, apiFetch));
  const sessionRepos: TeamSessionReposState = reposQuery.status === "success"
    ? { status: "ready", repos: reposQuery.data }
    : { status: reposQuery.status === "error" ? "error" : "loading", repos: reposQuery.data ?? [] };
  const reloadConnections = useRefreshQuery(queryKeys.connections(workspaceId));
  const reloadSessionRepos = useRefreshQuery(queryKeys.sessionRepos(workspaceId));
  const baseStatuses = webToolStatuses(connections.connections);
  const sessionsOn = baseStatuses["coding-sessions"]?.state === "connected";
  const statuses = { ...baseStatuses, "coding-sessions": codingSessionsStatus(sessionsOn, sessionRepos) };
  const refresh = () => reloadConnections();
  const slackRow = (connections.connections as Array<{ provider?: string; channel_ids?: string[] }>).find((row) => row.provider === "slack");
  const slackDetail = slackRow
    ? { connected: baseStatuses.slack?.state === "connected", status: baseStatuses.slack?.state ?? "disconnected", channelIds: slackRow.channel_ids ?? [] }
    : undefined;

  const sessionsPanel = () => (
    <CodingSessionsPanel
      detail={{ connected: sessionsOn, status: sessionsOn ? "connected" : "disconnected" }}
      repos={sessionRepos}
      onReloadRepos={reloadSessionRepos}
      onConnected={async () => { await refresh(); }}
      canPickRepo={false}
    />
  );

  const panels: Partial<Record<ToolId, (close: () => void) => ReactNode>> = {
    fireflies: (close) => <FirefliesConnectPanel detail={undefined} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    granola: (close) => <GranolaConnectPanel detail={undefined} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    gmail: (close) => {
      const needsReconnect = baseStatuses.gmail?.state === "error";
      return (
        <GoogleConnectPanel needsReconnect={needsReconnect} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close}>
          {needsReconnect && allowDisconnect && <DisconnectButton provider="gmail" />}
        </GoogleConnectPanel>
      );
    },
    linear: (close) => <LinearConnectPanel detail={undefined} classPrefix="ui-panel" onConnected={async () => { await refresh(); close(); }} />,
    github: (close) => <GithubPanel onDone={close} />,
    slack: (close) => <SlackConnectPanel detail={slackDetail} mode="connect" classPrefix="ui-panel" onMembershipUpdated={async () => { await refresh(); }} onConnected={async () => { await refresh(); close(); }} />,
    "coding-sessions": () => sessionsPanel(),
  };
  const managePanels: Partial<Record<ToolId, ManagePanel>> = {
    "coding-sessions": { label: "View repos", render: () => sessionsPanel() },
    slack: { label: "Manage channels", render: () => <SlackConnectPanel detail={slackDetail} mode="manage" classPrefix="ui-panel" onMembershipUpdated={async () => { await refresh(); }} onConnected={async () => { await refresh(); }} /> },
  };

  if (only) {
    const renderPanel = panels[only];
    return renderPanel ? <>{renderPanel(() => {})}</> : <p className="ui-muted">Connect this in the Draft desktop app.</p>;
  }

  return (
    <ToolList
      platform="web"
      groups={groups}
      statuses={statuses}
      agentPrompt={AGENT_SETUP_PROMPT}
      agentLastUsedAt={connections.agent?.last_used_at ?? null}
      mcpUrl={mcpUrl(API_URL)}
      panels={panels}
      managePanels={managePanels}
      connectedActions={allowDisconnect ? {
        fireflies: <DisconnectButton provider="fireflies" />,
        granola: <DisconnectButton provider="granola" query="?account_kind=personal" />,
        github: <DisconnectButton provider="github" />,
        slack: <DisconnectButton provider="slack" />,
        gmail: <DisconnectButton provider="gmail" />,
      } : {}}
      unavailableHint={unavailableHint}
      searchable
    />
  );
}

/** `only` renders one provider's connect panel without the tool list, for single-purpose pages. */
export function WebToolList({ groups, allowDisconnect = false, unavailableHint = DEFAULT_UNAVAILABLE_HINT, only }: { groups?: ToolGroup[]; allowDisconnect?: boolean; unavailableHint?: string; only?: ToolId }) {
  return (
    <DataBoundary fallback={<p className="ui-muted" role="status">Loading connections…</p>} errorMessage="Could not load your connections.">
      <WebToolListBody groups={groups} allowDisconnect={allowDisconnect} unavailableHint={unavailableHint} only={only} />
    </DataBoundary>
  );
}

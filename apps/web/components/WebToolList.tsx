"use client";

import { useState, type ReactNode } from "react";
import {
  CodingSessionsPanel,
  DataBoundary,
  FirefliesConnectPanel,
  GithubConnectPanel,
  GranolaConnectPanel,
  LinearConnectPanel,
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

function DisconnectButton({ provider, query = "" }: { provider: "fireflies" | "granola" | "github"; query?: string }) {
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

/** Web connects personal tools, Linear, GitHub and coding sessions; Slack needs the desktop app for now. */
function WebToolListBody({ groups, allowDisconnect, unavailableHint }: { groups?: ToolGroup[]; allowDisconnect: boolean; unavailableHint: string }) {
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
    linear: (close) => <LinearConnectPanel detail={undefined} classPrefix="ui-panel" onConnected={async () => { await refresh(); close(); }} />,
    github: (close) => <GithubPanel onDone={close} />,
    "coding-sessions": () => sessionsPanel(),
  };
  const managePanels: Partial<Record<ToolId, ManagePanel>> = { "coding-sessions": { label: "View repos", render: () => sessionsPanel() } };

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
      } : {}}
      unavailableHint={unavailableHint}
      searchable
    />
  );
}

export function WebToolList({ groups, allowDisconnect = false, unavailableHint = DEFAULT_UNAVAILABLE_HINT }: { groups?: ToolGroup[]; allowDisconnect?: boolean; unavailableHint?: string }) {
  return (
    <DataBoundary fallback={<p className="ui-muted" role="status">Loading connections…</p>} errorMessage="Could not load your connections.">
      <WebToolListBody groups={groups} allowDisconnect={allowDisconnect} unavailableHint={unavailableHint} />
    </DataBoundary>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import {
  FirefliesConnectPanel,
  GranolaConnectPanel,
  LinearConnectPanel,
  ToolList,
  useIntegrationActions,
  type ToolGroup,
  type ToolId,
} from "draft-shared-ui";
import { API_URL } from "@/lib/config";
import { apiFetch } from "@/lib/api";
import { webToolStatuses } from "@/lib/tool-statuses";
import { useWorkspace } from "@/lib/workspace";

export const AGENT_COMMAND = `claude mcp add --transport http draft ${API_URL}/mcp`;

function DisconnectButton({ provider, query = "" }: { provider: "fireflies" | "granola"; query?: string }) {
  const { workspaceId, reloadConnections } = useWorkspace();
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

/** Web only connects personal tools and Linear; Slack and GitHub need the desktop app for now. */
export function WebToolList({ groups, allowDisconnect = false }: { groups?: ToolGroup[]; allowDisconnect?: boolean }) {
  const { connections, reloadConnections } = useWorkspace();
  const statuses = webToolStatuses(connections.connections);
  const refresh = () => reloadConnections();

  const panels: Partial<Record<ToolId, (close: () => void) => ReactNode>> = {
    fireflies: (close) => <FirefliesConnectPanel detail={undefined} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    granola: (close) => <GranolaConnectPanel detail={undefined} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    linear: (close) => <LinearConnectPanel detail={undefined} classPrefix="ui-panel" onConnected={async () => { await refresh(); close(); }} />,
  };

  if (connections.status === "error") {
    return (
      <p className="ui-error" role="alert">
        Could not load your connections. <button type="button" className="ui-link" onClick={() => void refresh()}>Try again</button>
      </p>
    );
  }

  return (
    <ToolList
      platform="web"
      groups={groups}
      statuses={statuses}
      agentCommand={AGENT_COMMAND}
      agentLastUsedAt={connections.agentLastUsedAt}
      panels={panels}
      connectedActions={allowDisconnect ? {
        fireflies: <DisconnectButton provider="fireflies" />,
        granola: <DisconnectButton provider="granola" query="?account_kind=personal" />,
      } : {}}
      unavailableHint="Ask your admin to connect this in the Draft desktop app."
    />
  );
}

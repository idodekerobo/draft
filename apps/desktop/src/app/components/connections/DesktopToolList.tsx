import { useState, type ReactNode } from "react";
import {
  AGENT_SETUP_PROMPT,
  FirefliesConnectPanel,
  GoogleConnectPanel,
  DriveFoldersPanel,
  driveToolStatus,
  hasDriveConnection,
  hasGmailConnection,
  useSyncedGoogleDriveFolders,
  GranolaConnectPanel,
  LinearConnectPanel,
  SlackConnectPanel,
  ToolList,
  gmailToolStatus,
  mcpUrl,
  toolStatusesFromConnections,
  type ManagePanel,
  type ToolGroup,
  type ToolId,
  type ToolStatus,
} from "draft-shared-ui";
import type { ConnectedAppsStatus } from "../../../rpc/schema";
import { rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { GithubConnectPanel } from "../../adapters/GithubConnectPanel";

type Source = "slack" | "fireflies" | "linear" | "github" | "granola" | "gmail" | "google_drive";

export function desktopToolStatuses(apps: ConnectedAppsStatus): Partial<Record<ToolId, ToolStatus>> {
  const team = (["slack", "github", "linear"] as const).map((provider) => ({
    provider,
    status: apps.integrations[provider].status,
    display_name: apps.integrations[provider].displayName ?? null,
  }));
  const personal = [
    ...apps.firefliesConnections.map((row) => ({ ...row, provider: "fireflies" })),
    ...apps.granolaConnections.map((row) => ({ ...row, provider: "granola" })),
  ];
  return {
    ...toolStatusesFromConnections(personal, team),
    gmail: gmailToolStatus(apps.gmailConnections),
    "google-drive": driveToolStatus(apps.driveConnections ?? [], null),
  };
}

function DisconnectButton({ source, accountKind, onDone }: { source: Source; accountKind?: "personal"; onDone: () => Promise<boolean> }) {
  const { track } = useAnalytics();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function disconnect() {
    setBusy(true);
    setFailed(false);
    try {
      const result = await rpc.request.disconnectIntegration({ source, ...(accountKind ? { accountKind } : {}) });
      if (!result.ok) throw new Error(result.error);
      track("integration_disconnected", { source });
      await onDone();
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

export function DesktopToolList({ apps, refresh, groups, allowManage = false, startHere }: {
  apps: ConnectedAppsStatus;
  refresh: () => Promise<boolean>;
  groups?: ToolGroup[];
  /** Connections page: show Disconnect and manage actions on connected rows. */
  allowManage?: boolean;
  startHere?: ToolId;
}) {
  const driveFolders = useSyncedGoogleDriveFolders(hasDriveConnection(apps.driveConnections ?? []));
  const statuses = { ...desktopToolStatuses(apps), "google-drive": driveToolStatus(apps.driveConnections ?? [], driveFolders.status === "ready" ? driveFolders.folders.length : null) };
  const reload = async () => { await refresh(); };
  const connectedAndClose = (close: () => void) => async () => { await refresh(); close(); };
  const panels: Partial<Record<ToolId, (close: () => void) => ReactNode>> = {
    fireflies: (close) => <FirefliesConnectPanel detail={apps.integrations.fireflies} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    granola: (close) => <GranolaConnectPanel detail={apps.integrations.granola} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close} />,
    gmail: (close) => {
      const needsReconnect = gmailToolStatus(apps.gmailConnections).state === "error";
      return (
        <GoogleConnectPanel needsReconnect={needsReconnect} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={close}>
          {needsReconnect && allowManage && <DisconnectButton source="gmail" onDone={refresh} />}
        </GoogleConnectPanel>
      );
    },
    "google-drive": () => <GoogleConnectPanel product="drive" hasGmail={hasGmailConnection(apps.gmailConnections)} needsReconnect={statuses["google-drive"].state === "error"} classPrefix="ui-panel" onStatusRefresh={refresh} onDone={driveFolders.reload}>{statuses["google-drive"].state === "error" && allowManage && <DisconnectButton source="google_drive" onDone={refresh} />}</GoogleConnectPanel>,
    linear: (close) => <LinearConnectPanel detail={apps.integrations.linear} classPrefix="ui-panel" onConnected={connectedAndClose(close)} />,
    slack: (close) => <SlackConnectPanel detail={apps.integrations.slack} mode="connect" classPrefix="ui-panel" onMembershipUpdated={reload} onConnected={connectedAndClose(close)} />,
    github: (close) => <GithubConnectPanel detail={apps.integrations.github} classPrefix="ui-panel" onConnected={connectedAndClose(close)} />,
  };

  const managePanels: Partial<Record<ToolId, ManagePanel>> = allowManage ? {
    "google-drive": { label: "Edit", render: () => <DriveFoldersPanel state={driveFolders} /> },
    slack: { label: "Manage channels", render: () => <SlackConnectPanel detail={apps.integrations.slack} mode="manage" classPrefix="ui-panel" onMembershipUpdated={reload} onConnected={reload} /> },
  } : {};

  const connectedActions: Partial<Record<ToolId, ReactNode>> = allowManage ? {
    fireflies: <DisconnectButton source="fireflies" onDone={refresh} />,
    granola: <DisconnectButton source="granola" accountKind="personal" onDone={refresh} />,
    slack: <DisconnectButton source="slack" onDone={refresh} />,
    github: <DisconnectButton source="github" onDone={refresh} />,
    linear: <DisconnectButton source="linear" onDone={refresh} />,
    gmail: <DisconnectButton source="gmail" onDone={refresh} />,
    "google-drive": <DisconnectButton source="google_drive" onDone={refresh} />,
  } : {};

  return (
    <ToolList
      platform="desktop"
      groups={groups}
      statuses={statuses}
      agentPrompt={AGENT_SETUP_PROMPT}
      agentLastUsedAt={apps.agentLastUsedAt}
      mcpUrl={mcpUrl(apps.apiBaseUrl)}
      panels={panels}
      managePanels={managePanels}
      connectedActions={connectedActions}
      startHere={startHere}
      searchable={allowManage}
    />
  );
}

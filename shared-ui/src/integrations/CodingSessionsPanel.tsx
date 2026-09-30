"use client";

import type { IntegrationDetail, TeamSessionReposState } from "../types";
import { SessionTrackingPanel } from "./SessionTrackingPanel";
import { TeamSessionRepos } from "./TeamSessionRepos";

/** Expanded "Coding sessions" row: the team's capturing repos, then how to add one. */
export function CodingSessionsPanel({ detail, repos, onReloadRepos, onConnected, canPickRepo }: {
  detail: IntegrationDetail | undefined;
  repos: TeamSessionReposState;
  onReloadRepos: () => void | Promise<unknown>;
  onConnected: () => void | Promise<void>;
  /** True on desktop, where a local folder can be enabled directly. */
  canPickRepo: boolean;
}) {
  const connected = detail?.connected ?? false;
  return (
    <div className="ui-sessions-panel">
      {connected && <TeamSessionRepos state={repos} onRetry={onReloadRepos} />}
      <SessionTrackingPanel
        detail={detail}
        classPrefix="ui-panel"
        showRepoPicker={canPickRepo}
        onConnected={async () => { await onConnected(); await onReloadRepos(); }}
        onRepoEnabled={async () => { await onReloadRepos(); }}
      />
    </div>
  );
}

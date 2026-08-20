import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface SessionTrackingPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

const ENABLE_COMMAND = "draft sessions enable claude-code";

interface RepoResult {
  path: string;
  ok: boolean;
  message: string;
}

// Structurally mirrors FirefliesConnectPanel, but with no credential input.
export function SessionTrackingPanel({ detail, onConnected, classPrefix }: SessionTrackingPanelProps) {
  const { track } = useAnalytics();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [repoResults, setRepoResults] = useState<RepoResult[]>([]);
  // Flips instantly on click, independent of detail prop; rolled back on failure.
  const [optimisticConnected, setOptimisticConnected] = useState<boolean | null>(null);
  const connected = optimisticConnected ?? detail?.connected ?? false;

  async function turnOn() {
    setOptimisticConnected(true);
    setError(null);
    try {
      const result = await rpc.request.connectSessionTracking();
      if (!result.ok) {
        setOptimisticConnected(false);
        setError(result.error ?? "Could not turn on coding sessions.");
        return;
      }
      track("integration_connected", { source: "claude_session" });
      // Awaited so the optimistic override below isn't released before the real state lands.
      await onConnected();
    } catch {
      setOptimisticConnected(false);
      setError("Could not turn on coding sessions. Try again.");
    } finally {
      setOptimisticConnected((current) => (current === true ? null : current));
    }
  }

  async function addRepo() {
    const { folderPath } = await rpc.request.selectSessionRepoFolder();
    if (!folderPath) return;
    setEnabling(true);
    try {
      const result = await rpc.request.enableSessionCaptureForRepo({ folderPath });
      setRepoResults((current) => [
        ...current,
        { path: folderPath, ok: result.ok, message: result.ok ? "Enabled" : (result.error ?? "Could not enable this repo.") },
      ]);
      if (result.ok) track("integration_connected", { source: "claude_session_repo" });
    } finally {
      setEnabling(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(ENABLE_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  if (connected) {
    return (
      <div className={`${classPrefix}__connect-panel`}>
        <span className={`${classPrefix}__panel-label`}>Set up each repo</span>
        <span className={`${classPrefix}__panel-help`}>
          Coding sessions are on for this workspace. Pick a repo on this Mac to enable it directly:
        </span>
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void addRepo()} disabled={enabling}>
          {enabling ? "Enabling…" : "Choose a repo…"}
        </button>
        {repoResults.length > 0 && (
          <ul className={`${classPrefix}__repo-list`}>
            {repoResults.map((repo) => (
              <li key={repo.path} className={repo.ok ? undefined : `${classPrefix}__validation`}>
                {repo.path.split("/").pop()} — {repo.message}
              </li>
            ))}
          </ul>
        )}
        <span className={`${classPrefix}__panel-help`}>
          You — or your coding agent — can also enable it via the CLI. Run this in the repo:
        </span>
        <div className={`${classPrefix}__copy-row`}>
          <code>{ENABLE_COMMAND}</code>
          <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <span className={`${classPrefix}__panel-help`}>
          Sessions show up in Settings once captured — summarized and searchable from the CLI via <code>draft sessions list</code>.
        </span>
      </div>
    );
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Turn on coding sessions</span>
      <span className={`${classPrefix}__panel-help`}>
        Draft can capture, summarize, and search Claude Code sessions from your repos.
      </span>
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void turnOn()}>
        Turn on
      </button>
    </div>
  );
}

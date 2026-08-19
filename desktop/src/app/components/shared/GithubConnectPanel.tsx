import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { useGithubInstall } from "../../hooks/useGithubInstall";

interface GithubConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

export function GithubConnectPanel({ onConnected, classPrefix }: GithubConnectPanelProps) {
  const { track } = useAnalytics();
  const { phase, error, connect } = useGithubInstall(async () => {
    track("integration_connected", { source: "github" });
    await onConnected();
  });

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Install the Draft GitHub App</span>
      <span className={`${classPrefix}__panel-help`}>
        Choose which repos to grant access to on GitHub's install screen. Draft only reads pull request and
        commit activity — it never writes back to GitHub.
      </span>
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button
        type="button"
        className={`${classPrefix}__connect ${classPrefix}__panel-action`}
        onClick={() => void connect()}
        disabled={phase === "awaiting_approval"}
      >
        {phase === "awaiting_approval" ? "Waiting for GitHub…" : "Connect GitHub"}
      </button>
    </div>
  );
}

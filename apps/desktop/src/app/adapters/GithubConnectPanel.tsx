import type { IntegrationDetail } from "draft-shared-ui";
import { GithubConnectPanel as SharedGithubConnectPanel } from "draft-shared-ui/integrations";
import { useAnalytics } from "../analytics/AnalyticsContext";
import { useGithubInstall } from "../hooks/useGithubInstall";

interface GithubConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row" | "ui-panel";
}

export function GithubConnectPanel({ detail, onConnected, classPrefix }: GithubConnectPanelProps) {
  const { track } = useAnalytics();
  const { phase, error, connect } = useGithubInstall(async () => {
    track("integration_connected", { source: "github" });
    await onConnected();
  });

  return (
    <SharedGithubConnectPanel
      detail={detail}
      classPrefix={classPrefix}
      phase={phase}
      error={error}
      onConnected={onConnected}
      onConnect={connect}
    />
  );
}

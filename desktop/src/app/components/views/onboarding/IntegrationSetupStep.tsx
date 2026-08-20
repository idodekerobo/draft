import { useOptimistic, useState } from "react";
import type { ConnectedAppsStatus } from "../../../../rpc/schema";
import { FirefliesConnectPanel } from "../../shared/FirefliesConnectPanel";
import { GithubConnectPanel } from "../../shared/GithubConnectPanel";
import { LinearConnectPanel } from "../../shared/LinearConnectPanel";
import { SessionTrackingPanel } from "../../shared/SessionTrackingPanel";
// TODO: Granola still works locally but has no backend ingestion pipeline in
// the new cloud model (backend/src/ingestion only has fireflies/slack/
// linear/github) — connecting it can't get its data into source_items at
// all right now. GitHub is done (backend/src/ingestion/github); this card
// stays commented out until Granola gets the same treatment.
// import { GranolaConnectPanel } from "../../shared/GranolaConnectPanel";
import { SlackConnectPanel } from "../../shared/SlackConnectPanel";
import { IntegrationSetupCard } from "./shared";

interface IntegrationSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
  connections: ConnectedAppsStatus["integrations"] | null;
  loadConnections: () => Promise<void>;
}

type IntegrationName = "slack" | "fireflies" | "linear" | "github";

export function IntegrationSetupStep({ stepNum, totalSteps, onBack, onNext, connections, loadConnections }: IntegrationSetupStepProps) {
  const [expanded, setExpanded] = useState<IntegrationName | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Optimistic overlay so a successful connect shows "connected"
  // instead of flashing back to the pre-connect state while loadConnections() runs
  const [optimisticConnections, markConnected] = useOptimistic(
    connections,
    (current, name: IntegrationName) =>
      current ? { ...current, [name]: { ...current[name], connected: true } } : current,
  );

  function handleConnected(name: IntegrationName) {
    markConnected(name);
    void loadConnections().then(() => setExpanded(null));
  }

  const allConnected = optimisticConnections
    && optimisticConnections.slack.connected
    && optimisticConnections.fireflies.connected
    && optimisticConnections.linear.connected
    && optimisticConnections.github.connected;

  function toggle(name: IntegrationName, connected?: boolean) {
    if (connected) return;
    setError(null);
    setExpanded((current) => current === name ? null : name);
  }

  const slack = optimisticConnections?.slack;
  const fireflies = optimisticConnections?.fireflies;
  const linear = optimisticConnections?.linear;
  const github = optimisticConnections?.github;

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Connect your sources</h1>
      <p className="onboarding__desc">
        {allConnected
          ? "All integrations are connected. Draft will check them for updates and synthesize new context automatically."
          : "Draft routinely checks connected integrations — meeting notes and channel activity — and synthesizes updates into your workspace. Select which to set up now."}
      </p>
      {error && <p className="onboarding__error">{error}</p>}

      <div className="onboarding__integration-list">
        {/* TODO: Granola card — see file-header note */}

        <IntegrationSetupCard title="Slack" description="Capture channel activity for team context" hint="3 steps" connected={slack?.connected ?? false} expanded={expanded === "slack"} onToggle={() => toggle("slack", slack?.connected)}>
          <SlackConnectPanel detail={slack} classPrefix="onboarding" onConnected={() => handleConnected("slack")} />
        </IntegrationSetupCard>
        {slack?.connected && (
          <p className="onboarding__integration-help">
            Invite the bot to each channel you selected — run <code>/invite @Draft Context</code> in Slack.
            The bot reads messages but never posts; this is required for capture to work.
          </p>
        )}

        <IntegrationSetupCard title="GitHub" description="Track pull request and commit activity" hint="1 step" connected={github?.connected ?? false} expanded={expanded === "github"} onToggle={() => toggle("github", github?.connected)}>
          <GithubConnectPanel detail={github} classPrefix="onboarding" onConnected={() => handleConnected("github")} />
        </IntegrationSetupCard>

        <IntegrationSetupCard title="Fireflies" description="Import your meeting notes" hint="1 step" connected={fireflies?.connected ?? false} expanded={expanded === "fireflies"} onToggle={() => toggle("fireflies", fireflies?.connected)}>
          <FirefliesConnectPanel detail={fireflies} classPrefix="onboarding" onConnected={() => handleConnected("fireflies")} />
        </IntegrationSetupCard>

        <IntegrationSetupCard title="Linear" description="Track issues, projects, and cycles" hint="1 step" connected={linear?.connected ?? false} expanded={expanded === "linear"} onToggle={() => toggle("linear", linear?.connected)}>
          <LinearConnectPanel detail={linear} classPrefix="onboarding" onConnected={() => handleConnected("linear")} />
        </IntegrationSetupCard>

        <SessionTrackingPanel detail={optimisticConnections?.claudeSession} onChanged={loadConnections} variant="onboarding" />
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        {!allConnected && <button className="onboarding__skip" onClick={onNext}>Skip all</button>}
      </div>
    </div>
  );
}

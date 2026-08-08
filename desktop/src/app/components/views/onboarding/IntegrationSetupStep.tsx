import { useOptimistic, useState } from "react";
import type { ConnectedAppsStatus } from "../../../../rpc/schema";
import { FirefliesConnectPanel } from "../../shared/FirefliesConnectPanel";
// TODO: Granola and GitHub connect flows still work locally, but neither has
// a backend ingestion pipeline in the new cloud model (backend/src/ingestion
// only has fireflies/ and slack/) — connecting them can't get their data into
// source_items at all right now. Cards commented out below rather than
// removed until ingestion exists for them.
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

type IntegrationName = "slack" | "fireflies";

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
    && optimisticConnections.fireflies.connected;

  function toggle(name: IntegrationName, connected?: boolean) {
    if (connected) return;
    setError(null);
    setExpanded((current) => current === name ? null : name);
  }

  const slack = optimisticConnections?.slack;
  const fireflies = optimisticConnections?.fireflies;

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

        {/* TODO: GitHub card — see file-header note */}

        <IntegrationSetupCard title="Fireflies" description="Import your meeting notes" hint="1 step" connected={fireflies?.connected ?? false} expanded={expanded === "fireflies"} onToggle={() => toggle("fireflies", fireflies?.connected)}>
          <FirefliesConnectPanel detail={fireflies} classPrefix="onboarding" onConnected={() => handleConnected("fireflies")} />
        </IntegrationSetupCard>
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        {!allConnected && <button className="onboarding__skip" onClick={onNext}>Skip all</button>}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { ConnectedAppsStatus, IntegrationDetail } from "../../../../rpc/schema";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { rpc } from "../../../rpc";
import { FirefliesConnectPanel } from "../../shared/FirefliesConnectPanel";
import { GranolaConnectPanel } from "../../shared/GranolaConnectPanel";
import { SlackConnectPanel } from "../../shared/SlackConnectPanel";
import { IntegrationSetupCard } from "./shared";

interface IntegrationSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type IntegrationName = "granola" | "slack" | "github" | "fireflies";

export function IntegrationSetupStep({ stepNum, totalSteps, onBack, onNext }: IntegrationSetupStepProps) {
  const { track } = useAnalytics();
  const [connections, setConnections] = useState<ConnectedAppsStatus["integrations"] | null>(null);
  const [expanded, setExpanded] = useState<IntegrationName | null>(null);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadConnections() {
    try {
      const result = await rpc.request.getConnectedApps();
      setConnections(result.integrations);
    } catch {
      setError("Could not load integration status. You can still connect an integration.");
    }
  }

  useEffect(() => { void loadConnections(); }, []);

  useEffect(() => {
    if (!connectingGitHub) return;
    const interval = setInterval(async () => {
      try {
        const result = await rpc.request.getConnectedApps();
        setConnections(result.integrations);
        if (result.integrations.github.connected) {
          setConnectingGitHub(false);
          track("integration_connected", { source: "github" });
        }
      } catch { /* Keep polling while the browser flow is active. */ }
    }, 2_000);
    const timeout = setTimeout(() => {
      setConnectingGitHub(false);
      setError("GitHub sign-in timed out. Try again.");
    }, 5 * 60 * 1_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [connectingGitHub, track]);

  const allConnected = connections
    && connections.granola.connected
    && connections.slack.connected
    && connections.github.connected;

  function toggle(name: IntegrationName, detail?: IntegrationDetail) {
    if (detail?.connected) return;
    setError(null);
    setExpanded((current) => current === name ? null : name);
  }

  async function connectGitHub() {
    setError(null);
    setConnectingGitHub(true);
    try {
      const result = await rpc.request.connectGitHub();
      if (!result.ok) {
        setError(result.error ?? "GitHub connect failed.");
        setConnectingGitHub(false);
      }
    } catch {
      setError("GitHub connect failed.");
      setConnectingGitHub(false);
    }
  }

  const granola = connections?.granola;
  const slack = connections?.slack;
  const github = connections?.github;
  const fireflies = connections?.fireflies;

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
          : "Draft routinely checks connected integrations — meeting notes, channel activity, repository changes — and synthesizes updates into your workspace. Select which to set up now."}
      </p>
      {error && <p className="onboarding__error">{error}</p>}

      <div className="onboarding__integration-list">
        <IntegrationSetupCard title="Granola" description="Import your meeting notes" hint="1 step" connected={granola?.connected ?? false} expanded={expanded === "granola"} onToggle={() => toggle("granola", granola)}>
          <GranolaConnectPanel detail={granola} classPrefix="onboarding" onConnected={async () => { await loadConnections(); setExpanded(null); }} />
        </IntegrationSetupCard>

        <IntegrationSetupCard title="Slack" description="Capture channel activity for team context" hint="3 steps" connected={slack?.connected ?? false} expanded={expanded === "slack"} onToggle={() => toggle("slack", slack)}>
          <SlackConnectPanel detail={slack} classPrefix="onboarding" onConnected={async () => { await loadConnections(); setExpanded(null); }} />
        </IntegrationSetupCard>
        {slack?.connected && (
          <p className="onboarding__integration-help">
            Invite the bot to each channel you selected — run <code>/invite @Draft Context</code> in Slack.
            The bot reads messages but never posts; this is required for capture to work.
          </p>
        )}

        <IntegrationSetupCard title="GitHub" description="Track repositories and pull requests" hint="1 step" connected={github?.connected ?? false} expanded={false} onToggle={() => void connectGitHub()} action={connectingGitHub ? "Waiting…" : "Connect"} />

        <IntegrationSetupCard title="Fireflies" description="Import your meeting notes" hint="1 step" connected={fireflies?.connected ?? false} expanded={expanded === "fireflies"} onToggle={() => toggle("fireflies", fireflies)}>
          <FirefliesConnectPanel detail={fireflies} classPrefix="onboarding" onConnected={async () => { await loadConnections(); setExpanded(null); }} />
        </IntegrationSetupCard>
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        {!allConnected && <button className="onboarding__skip" onClick={onNext}>Skip all</button>}
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import type { ConnectedAppsStatus, IntegrationDetail } from "../../../../rpc/schema";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { rpc } from "../../../rpc";

interface IntegrationSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type IntegrationName = "granola" | "slack" | "github";

export function IntegrationSetupStep({ stepNum, totalSteps, onBack, onNext }: IntegrationSetupStepProps) {
  const { track } = useAnalytics();
  const [connections, setConnections] = useState<ConnectedAppsStatus["integrations"] | null>(null);
  const [expanded, setExpanded] = useState<IntegrationName | null>(null);
  const [granolaMode, setGranolaMode] = useState<"mcp" | "api">("mcp");
  const [granolaKey, setGranolaKey] = useState("");
  const [slackStep, setSlackStep] = useState(1);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [saving, setSaving] = useState<IntegrationName | null>(null);
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

  function toggle(name: IntegrationName, detail?: IntegrationDetail) {
    if (detail?.connected) return;
    setError(null);
    setExpanded((current) => current === name ? null : name);
  }

  async function connectGranola() {
    setSaving("granola");
    setError(null);
    try {
      const result = granolaMode === "mcp"
        ? await rpc.request.connectGranolaMCP()
        : await rpc.request.connectGranolaAPI({ apiKey: granolaKey });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Granola.");
        return;
      }
      track("integration_connected", { source: "granola" });
      await loadConnections();
      setExpanded(null);
    } catch {
      setError("Could not connect Granola. Try again.");
    } finally {
      setSaving(null);
    }
  }

  async function connectSlack() {
    setSaving("slack");
    setError(null);
    try {
      const result = await rpc.request.connectSlack({ botToken, appToken });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Slack.");
        return;
      }
      track("integration_connected", { source: "slack" });
      await loadConnections();
      setExpanded(null);
    } catch {
      setError("Could not connect Slack. Try again.");
    } finally {
      setSaving(null);
    }
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

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Connect your sources</h1>
      <p className="onboarding__desc">Select which integrations to set up now. You can add more later in Settings.</p>
      {error && <p className="onboarding__error">{error}</p>}

      <div className="onboarding__integration-list">
        <IntegrationCard name="granola" title="Granola" description="Import your meeting notes" hint="1 step" detail={granola} expanded={expanded === "granola"} onToggle={() => toggle("granola", granola)}>
          <p className="onboarding__integration-step-indicator">Connection method</p>
          <div className="onboarding__mode-picker">
            <button className={granolaMode === "mcp" ? "onboarding__mode--selected" : ""} onClick={() => setGranolaMode("mcp")}>MCP (recommended)</button>
            <button className={granolaMode === "api" ? "onboarding__mode--selected" : ""} onClick={() => setGranolaMode("api")}>API key</button>
          </div>
          {granolaMode === "mcp" ? (
            <p className="onboarding__integration-help">Register Granola with Claude Code automatically. Authenticate in Claude Code on your next session.</p>
          ) : (
            <input className="onboarding__integration-input" type="password" value={granolaKey} onChange={(event) => setGranolaKey(event.target.value)} placeholder="Granola API key" aria-label="Granola API key" />
          )}
          <button className="empty-state__cta onboarding__cta" onClick={() => void connectGranola()} disabled={saving === "granola" || (granolaMode === "api" && !granolaKey.trim())}>
            {saving === "granola" ? "Connecting…" : "Connect Granola"}
          </button>
        </IntegrationCard>

        <IntegrationCard name="slack" title="Slack" description="Capture channel activity for team context" hint="3 steps · includes browser setup" detail={slack} expanded={expanded === "slack"} onToggle={() => toggle("slack", slack)}>
          <p className="onboarding__integration-step-indicator">Step {slackStep} of 3</p>
          {slackStep === 1 && <>
            <p className="onboarding__integration-help">Create or select a Slack app, enable Socket Mode, and copy its credentials.</p>
            <button className="empty-state__cta onboarding__cta" onClick={() => { rpc.send.openUrl({ url: "https://api.slack.com/apps" }); setSlackStep(2); }}>Open Slack app setup</button>
          </>}
          {slackStep === 2 && <>
            <input className="onboarding__integration-input" type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="Bot token (xoxb-...)" aria-label="Slack bot token" />
            <button className="empty-state__cta onboarding__cta" onClick={() => setSlackStep(3)} disabled={!botToken.startsWith("xoxb-")}>Continue</button>
          </>}
          {slackStep === 3 && <>
            <input className="onboarding__integration-input" type="password" value={appToken} onChange={(event) => setAppToken(event.target.value)} placeholder="App token (xapp-...)" aria-label="Slack app token" />
            <button className="empty-state__cta onboarding__cta" onClick={() => void connectSlack()} disabled={saving === "slack" || !appToken.startsWith("xapp-")}> {saving === "slack" ? "Connecting…" : "Connect Slack"}</button>
          </>}
        </IntegrationCard>

        <IntegrationCard name="github" title="GitHub" description="Track repositories and pull requests" hint="1 step" detail={github} expanded={false} onToggle={() => void connectGitHub()} action={connectingGitHub ? "Waiting…" : "Connect"} />
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        <button className="onboarding__skip" onClick={onNext}>Skip all</button>
      </div>
    </div>
  );
}

function IntegrationCard({ name, title, description, hint, detail, expanded, onToggle, children, action }: {
  name: IntegrationName;
  title: string;
  description: string;
  hint: string;
  detail?: IntegrationDetail;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  action?: string;
}) {
  const connected = detail?.connected ?? false;
  return (
    <section className="onboarding__integration-card">
      <button className="onboarding__integration-header" onClick={onToggle} aria-expanded={expanded} disabled={connected}>
        <span className="onboarding__integration-title"><span>{title}</span><small>{description}</small></span>
        <span className="onboarding__integration-status">
          {connected ? <span className="onboarding__integration-badge onboarding__integration-badge--connected">Connected</span> : <><small>{hint}</small>{action ?? (expanded ? "▲" : "▼")}</>}
        </span>
      </button>
      {!connected && expanded && <div className="onboarding__integration-content">{children}</div>}
    </section>
  );
}

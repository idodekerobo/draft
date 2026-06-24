import { useEffect, useState } from "react";
import type { ConnectedAppsStatus, IntegrationDetail } from "../../../../rpc/schema";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { rpc } from "../../../rpc";
import { IntegrationSetupCard } from "./shared";

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
  const [slackStep, setSlackStep] = useState<1 | 2>(1);
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

  const allConnected = connections
    && connections.granola.connected
    && connections.slack.connected
    && connections.github.connected;

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
        const msg = granolaMode === "mcp"
          ? "MCP registration failed. Try API key instead."
          : "Invalid token. Check Settings → API → Personal access token in Granola.";
        setError(result.error ?? msg);
        return;
      }
      track("integration_connected", { source: "granola" });
      await loadConnections();
      setExpanded(null);
    } catch {
      setError(granolaMode === "mcp"
        ? "MCP registration failed. Try API key instead."
        : "Could not connect Granola. Try again.");
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
        setError(result.error ?? "Could not connect Slack. Check bot permissions.");
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
      <p className="onboarding__desc">
        {allConnected
          ? "All integrations are connected. Draft will check them for updates and synthesize new context automatically."
          : "Draft routinely checks connected integrations — meeting notes, channel activity, repository changes — and synthesizes updates into your workspace. Select which to set up now."}
      </p>
      {error && <p className="onboarding__error">{error}</p>}

      <div className="onboarding__integration-list">
        <IntegrationSetupCard title="Granola" description="Import your meeting notes" hint="1 step" connected={granola?.connected ?? false} expanded={expanded === "granola"} onToggle={() => toggle("granola", granola)}>
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
          {error && saving === null && expanded === "granola" && granolaMode === "mcp" && (
            <button className="onboarding__mode-switch" onClick={() => setGranolaMode("api")}>Try API key instead</button>
          )}
          <button className="empty-state__cta onboarding__cta" onClick={() => void connectGranola()} disabled={saving === "granola" || (granolaMode === "api" && !granolaKey.trim())}>
            {saving === "granola" ? "Connecting…" : "Connect Granola"}
          </button>
        </IntegrationSetupCard>

        <IntegrationSetupCard title="Slack" description="Capture channel activity for team context" hint="2 steps" connected={slack?.connected ?? false} expanded={expanded === "slack"} onToggle={() => toggle("slack", slack)}>
          <p className="onboarding__integration-step-indicator">Step {slackStep} of 2</p>
          {slackStep === 1 && <>
            <p className="onboarding__integration-help">Draft creates a read-only Slack app in your workspace to capture channel activity. You'll pick the workspace, create the app, then copy two tokens back here.</p>
            <button className="empty-state__cta onboarding__cta" onClick={async () => {
              const result = await rpc.request.getSlackManifestUrl();
              if (result.ok && result.url) {
                rpc.send.openUrl({ url: result.url });
              } else {
                rpc.send.openUrl({ url: "https://api.slack.com/apps" });
                setError(result.error ?? "Could not load manifest. Create the app manually.");
              }
              setSlackStep(2);
            }}>Create Slack app</button>
          </>}
          {slackStep === 2 && <>
            <p className="onboarding__integration-help">In the browser window that just opened:</p>
            <ol className="onboarding__integration-steps">
              <li>Pick your workspace and click <strong>Next</strong> → review the manifest → <strong>Create</strong></li>
              <li>In the sidebar, go to <strong>OAuth &amp; Permissions</strong> → click <strong>Install to Workspace</strong> → <strong>Allow</strong></li>
            </ol>
            <p className="onboarding__integration-label">Bot token</p>
            <p className="onboarding__integration-hint">Found in <strong>OAuth &amp; Permissions</strong> → under <strong>OAuth Tokens</strong></p>
            <input className="onboarding__integration-input" type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="xoxb-..." aria-label="Slack bot token" />
            {botToken.length > 0 && !botToken.startsWith("xoxb-") && (
              <p className="onboarding__integration-validation">Bot tokens start with xoxb-.</p>
            )}
            <p className="onboarding__integration-label">App-level token</p>
            <p className="onboarding__integration-hint">Found in <strong>Basic Information</strong> → under <strong>App-Level Tokens</strong> → click <strong>Generate Token and Scopes</strong> → add scope <code>connections:write</code> → <strong>Generate</strong></p>
            <input className="onboarding__integration-input" type="password" value={appToken} onChange={(event) => setAppToken(event.target.value)} placeholder="xapp-..." aria-label="Slack app-level token" />
            {appToken.length > 0 && !appToken.startsWith("xapp-") && (
              <p className="onboarding__integration-validation">App-level tokens start with xapp-.</p>
            )}
            <button className="empty-state__cta onboarding__cta" onClick={() => void connectSlack()} disabled={saving === "slack" || !botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")}>
              {saving === "slack" ? "Connecting…" : "Connect Slack"}
            </button>
          </>}
        </IntegrationSetupCard>

        <IntegrationSetupCard title="GitHub" description="Track repositories and pull requests" hint="1 step" connected={github?.connected ?? false} expanded={false} onToggle={() => void connectGitHub()} action={connectingGitHub ? "Waiting…" : "Connect"} />
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        {!allConnected && <button className="onboarding__skip" onClick={onNext}>Skip all</button>}
      </div>
    </div>
  );
}

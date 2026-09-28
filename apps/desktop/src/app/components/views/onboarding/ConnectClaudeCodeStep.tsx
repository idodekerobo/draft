// ConnectClaudeCodeStep.tsx — give the cloud sandbox a Claude Code OAuth token

import { useEffect, useState } from "react";
import { rpc } from "../../../rpc";
import { useUserIdentity } from "../../../identity/UserIdentityContext";
import { TOOL_PREREQS } from "./constants";

interface ConnectClaudeCodeStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

export function ConnectClaudeCodeStep({ stepNum, totalSteps, onBack, onNext }: ConnectClaudeCodeStepProps) {
  const identity = useUserIdentity();
  const [alreadyConnected, setAlreadyConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!(identity.hydrated && identity.signedIn && identity.workspaceId !== null)) return;
    let live = true;
    rpc.request.getConnectedApps()
      .then((status) => { if (live) setAlreadyConnected(status.claudeCode.connected); })
      .catch(() => { if (live) setAlreadyConnected(false); });
    return () => { live = false; };
  }, [identity.hydrated, identity.signedIn, identity.workspaceId]);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.connectClaudeCode({ token });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Claude Code. Check your token.");
        return;
      }
      setToken("");
      onNext();
    } catch {
      setError("Could not connect Claude Code. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Connect Claude Code</h1>
      <p className="onboarding__desc">
        Draft runs Claude Code in the cloud to synthesize your team's context. Give it a
        Claude Code OAuth token so it can act on your workspace's behalf.
      </p>

      {alreadyConnected === null ? (
        <p className="onboarding__desc">Checking connection…</p>
      ) : alreadyConnected ? (
        <div className="onboarding__connect-panel">
          <span className="onboarding__panel-label">Your team already connected Claude Code</span>
          <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        </div>
      ) : (
        <div className="onboarding__connect-panel">
          <span className="onboarding__panel-label">Get a token</span>
          <span className="onboarding__panel-help">
            Install the Claude Code CLI, then run <code>claude setup-token</code> in your terminal
            and paste the result here.
          </span>
          <button
            type="button"
            className="onboarding__panel-link onboarding__panel-action"
            onClick={() => rpc.send.openUrl({ url: TOOL_PREREQS["claude-code"]!.url })}
          >
            Install Claude Code CLI ↗
          </button>
          <input
            className="onboarding__input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Claude Code OAuth token"
            aria-label="Claude Code OAuth token"
          />
          {error && <span className="onboarding__validation">{error}</span>}
          <button
            type="button"
            className="onboarding__connect onboarding__panel-action"
            onClick={() => void connect()}
            disabled={saving || !token.trim()}
          >
            {saving ? "Connecting…" : "Connect Claude Code"}
          </button>
        </div>
      )}

      <p className="onboarding__hint">Codex — coming soon.</p>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../../rpc";
import { CodexConnectRow } from "../../connections/CodexConnectRow";
import { claudeRowState, type ClaudeRunner } from "./claude-row-state";

const CLAUDE_INSTALL_URL = "https://claude.com/claude-code";

function ClaudeSessionRow() {
  const [runner, setRunner] = useState<ClaudeRunner>(null);
  const [signInOpened, setSignInOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    void rpc.request.getAvailableRunners().then(({ runners }) => {
      const claude = runners.find((entry) => entry.name === "claude");
      setRunner(claude ? { installed: claude.installed, auth: claude.auth } : { installed: false, auth: "unknown" });
    }).catch(() => {});
  }, []);

  // Installing or signing in happens outside the app, so look again when the person comes back.
  useEffect(() => {
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  async function signIn() {
    setError(null);
    const result = await rpc.request.openClaudeSignIn().catch(() => ({ ok: false as const, error: "Could not open the terminal." }));
    if (result.ok) setSignInOpened(true);
    else setError(result.error ?? "Could not open the terminal.");
  }

  const { description, action } = claudeRowState(runner, signInOpened);

  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Claude Code</span>
        <span className="settings__row-desc">{description}</span>
        {error && <span className="ui-error" role="alert">{error}</span>}
      </div>
      {action === "install" && (
        <button type="button" className="settings__action-button" onClick={() => rpc.send.openUrl({ url: CLAUDE_INSTALL_URL })}>Install guide</button>
      )}
      {action === "sign_in" && (
        <button type="button" className="settings__action-button" onClick={() => void signIn()}>Sign in</button>
      )}
    </div>
  );
}

/** Detects Claude Code and Codex on this computer and gets each one ready for sessions in Draft. */
export function AgentsSetup() {
  return (
    <div className="settings__rows">
      <ClaudeSessionRow />
      <CodexConnectRow />
    </div>
  );
}

import { useEffect, useState } from "react";
import { rpc } from "../../rpc";

type Status = { installed: boolean; auth: "signed_in" | "signed_out" | "unknown" } | null;

/** Whether Claude Code is installed and signed in here. Signing in happens in its own terminal app, so there is no action. */
export function ClaudeCodeRow() {
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void rpc.request.getAvailableRunners().then(({ runners }) => {
      const claude = runners.find((runner) => runner.name === "claude");
      setStatus(claude ? { installed: claude.installed, auth: claude.auth } : null);
    }).catch(() => {});
  }, []);

  const description =
    !status ? "Checking…"
    : !status.installed ? "Claude Code is not installed on this computer. Install it from claude.com/claude-code."
    : status.auth === "signed_out" ? "Not signed in. Run claude in a terminal and sign in."
    : status.auth === "signed_in" ? "Signed in. You can start Claude Code sessions."
    : "Installed. You can start Claude Code sessions.";

  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Claude Code</span>
        <span className="settings__row-desc">{description}</span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useRoutineAgents } from "../../hooks/useRoutineAgents";
import { rpc } from "../../rpc";
import { AgentRow, type AgentLine } from "./AgentRow";
import { ClaudeTokenForm } from "./ClaudeTokenForm";

type LocalStatus = { installed: boolean; auth: "signed_in" | "signed_out" | "unknown" } | null;

/** Claude Code in Settings: its status on this computer, and the token the workspace's routines run with. */
export function ClaudeAgentRow() {
  const [local, setLocal] = useState<LocalStatus>(null);
  const [entering, setEntering] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasEntering = useRef(false);
  const { status, refresh } = useRoutineAgents();
  const routinesStatus = status("claude");

  useEffect(() => {
    void rpc.request.getAvailableRunners().then(({ runners }) => {
      const claude = runners.find((runner) => runner.name === "claude");
      setLocal(claude ? { installed: claude.installed, auth: claude.auth } : null);
    }).catch(() => {});
  }, []);

  // Closing the form gives focus back to the button that opened it.
  useEffect(() => {
    if (wasEntering.current && !entering) trigger.current?.focus();
    wasEntering.current = entering;
  }, [entering]);

  // Signing in happens in Claude Code's own terminal app, so the sessions line has no action.
  const sessionsLine: AgentLine = {
    label: "Sessions on this computer",
    description:
      !local ? "Checking…"
      : !local.installed ? "Claude Code is not installed on this computer. Install it from claude.com/claude-code."
      : local.auth === "signed_out" ? "Not signed in. Run claude in a terminal and sign in."
      : local.auth === "signed_in" ? "Signed in. You can start Claude Code sessions."
      : "Installed. You can start Claude Code sessions.",
  };

  const routinesLine: AgentLine = {
    label: "Routines in the cloud",
    description:
      !routinesStatus ? "Checking…"
      : routinesStatus === "connected" ? "Connected. Routines can run on Claude Code."
      : routinesStatus === "needs_reconnect" ? "The token stopped working. Paste a new one."
      : "Not connected. Run claude setup-token in a terminal and paste the token. Everyone in this workspace shares it.",
    extra: entering && (
      <ClaudeTokenForm autoFocus onSaved={() => { setEntering(false); refresh(); }} onCancel={() => setEntering(false)} />
    ),
    actions: routinesStatus && !entering && (
      <button ref={trigger} type="button" className="settings__action-button" onClick={() => setEntering(true)}>{routinesStatus === "not_connected" ? "Connect" : "Replace token"}</button>
    ),
  };

  return <AgentRow name="Claude Code" lines={[sessionsLine, routinesLine]} />;
}

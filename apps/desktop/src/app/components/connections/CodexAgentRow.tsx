import { harnessInstallUrl } from "draft-core/harnesses";
import { useCodexConnection } from "../../hooks/useCodexConnection";
import { useRoutineAgents } from "../../hooks/useRoutineAgents";
import { useRoutineCodex } from "../../hooks/useRoutineCodex";
import { rpc } from "../../rpc";
import { AgentRow, type AgentLine } from "./AgentRow";
import { DeviceCodeSteps } from "./DeviceCodeSteps";

const ACTION = "settings__action-button";

/** Codex in Settings: the sign-in for sessions on this computer, and the login the workspace's routines run with. */
export function CodexAgentRow() {
  const sessions = useCodexConnection();
  const { status, refresh } = useRoutineAgents();
  const routines = useRoutineCodex(status("codex"), refresh);
  const installUrl = harnessInstallUrl("codex");

  const sessionsLine: AgentLine = {
    label: "Sessions on this computer",
    description:
      sessions.phase === "loading" ? "Checking…"
      : sessions.phase === "not_installed" ? "Codex is not installed on this computer."
      : sessions.phase === "signed_in" ? "Signed in. You can start Codex sessions."
      : sessions.phase === "signing_in" && sessions.device ? "Open the link and enter this code to finish signing in."
      : sessions.phase === "signing_in" ? "Finish signing in in your browser."
      : "Sign in with ChatGPT to start Codex sessions from Draft.",
    extra: (
      <>
        {sessions.device && <DeviceCodeSteps url={sessions.device.url} code={sessions.device.code} />}
        {sessions.phase === "signed_out" && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" disabled={sessions.starting !== null} onClick={() => void sessions.signIn({ deviceCode: true })}>{sessions.starting === "code" ? "Getting a code…" : "Use a code instead"}</button>
          </span>
        )}
      </>
    ),
    error: sessions.error,
    actions: (
      <>
        {sessions.phase === "not_installed" && installUrl && <button type="button" className={ACTION} onClick={() => rpc.send.openUrl({ url: installUrl })}>Install guide</button>}
        {sessions.phase === "signed_out" && <button type="button" className={ACTION} disabled={sessions.starting !== null} onClick={() => void sessions.signIn({ deviceCode: false })}>{sessions.starting === "browser" ? "Opening…" : "Sign in"}</button>}
        {sessions.phase === "signing_in" && <button type="button" className={ACTION} onClick={() => void sessions.cancel()}>Cancel</button>}
        {sessions.phase === "signed_in" && <button type="button" className={ACTION} onClick={() => void sessions.signOut()}>Sign out</button>}
      </>
    ),
  };

  const canConnect = routines.phase === "not_connected" || routines.phase === "needs_reconnect" || routines.phase === "connected";
  const routinesLine: AgentLine = {
    label: "Routines in the cloud",
    description:
      routines.phase === "loading" ? "Checking…"
      : routines.phase === "not_connected" ? "Not connected. Sign in with a ChatGPT account for routines. It is separate from your own Codex login, and everyone in this workspace shares it."
      : routines.phase === "connected" ? "Connected. Routines can run on Codex."
      : routines.phase === "needs_reconnect" ? "The login stopped working. Sign in again to keep Codex routines running."
      : routines.device ? "Open the link and enter this code to finish signing in."
      : "Finish signing in in your browser.",
    extra: (
      <>
        {routines.device && <DeviceCodeSteps url={routines.device.url} code={routines.device.code} />}
        {canConnect && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" disabled={routines.starting !== null} onClick={() => void routines.connect({ deviceCode: true })}>{routines.starting === "code" ? "Getting a code…" : "Use a code instead"}</button>
          </span>
        )}
      </>
    ),
    error: routines.error,
    actions: (
      <>
        {canConnect && <button type="button" className={ACTION} disabled={routines.starting !== null} onClick={() => void routines.connect({ deviceCode: false })}>{routines.starting === "browser" ? "Opening…" : routines.phase === "not_connected" ? "Connect" : "Reconnect"}</button>}
        {routines.phase === "signing_in" && <button type="button" className={ACTION} onClick={() => void routines.cancel()}>Cancel</button>}
      </>
    ),
  };

  return <AgentRow name="Codex" lines={[sessionsLine, routinesLine]} />;
}

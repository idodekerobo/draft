import { useRoutineCodex } from "../../hooks/useRoutineCodex";
import { rpc } from "../../rpc";

/** The Codex login the workspace's routines run with. It is a separate login from the one this computer uses. */
export function RoutineCodexRow() {
  const { phase, device, error, connect, cancel } = useRoutineCodex();

  const description =
    phase === "loading" ? "Checking…"
    : phase === "unknown" ? "Could not check Codex for routines."
    : phase === "not_connected" ? "Routines cannot use Codex yet. Sign in with a ChatGPT account for them. It is separate from your own Codex login, and everyone in this workspace shares it."
    : phase === "connected" ? "Connected. Routines can run on Codex."
    : phase === "needs_reconnect" ? "The login stopped working. Sign in again to keep Codex routines running."
    : device ? "Open the link and enter this code to finish signing in."
    : "Finish signing in in your browser.";

  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Codex for routines</span>
        <span className="settings__row-desc">{description}</span>
        {device && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: device.url })}>{device.url}</button>
            {" "}
            <code aria-label="One-time code">{device.code}</code>
          </span>
        )}
        {(phase === "not_connected" || phase === "needs_reconnect" || phase === "connected") && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" onClick={() => void connect({ deviceCode: true })}>Use a code instead</button>
          </span>
        )}
        {error && <span className="ui-error" role="alert">{error}</span>}
      </div>
      {(phase === "not_connected" || phase === "needs_reconnect" || phase === "connected") && (
        <button type="button" className="settings__action-button" onClick={() => void connect({ deviceCode: false })}>{phase === "not_connected" ? "Connect" : "Reconnect"}</button>
      )}
      {phase === "signing_in" && (
        <button type="button" className="settings__action-button" onClick={() => void cancel()}>Cancel</button>
      )}
    </div>
  );
}

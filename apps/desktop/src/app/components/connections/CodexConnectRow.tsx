import { harnessInstallUrl } from "draft-core/harnesses";
import { useCodexConnection } from "../../hooks/useCodexConnection";
import { rpc } from "../../rpc";

/** Sign in and out of Codex from Draft. The login belongs to the person's own Codex, not to Draft. */
export function CodexConnectRow() {
  const { phase, device, error, signIn, cancel, signOut } = useCodexConnection();

  const description =
    phase === "loading" ? "Checking…"
    : phase === "not_installed" ? "Codex is not installed on this computer."
    : phase === "signed_in" ? "Signed in. You can start Codex sessions."
    : phase === "signing_in" && device ? "Open the link and enter this code to finish signing in."
    : phase === "signing_in" ? "Finish signing in in your browser."
    : "Sign in with ChatGPT to start Codex sessions from Draft.";

  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Codex</span>
        <span className="settings__row-desc">{description}</span>
        {device && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: device.url })}>{device.url}</button>
            {" "}
            <code aria-label="One-time code">{device.code}</code>
          </span>
        )}
        {phase === "signed_out" && (
          <span className="settings__row-desc">
            <button type="button" className="ui-link" onClick={() => void signIn({ deviceCode: true })}>Use a code instead</button>
          </span>
        )}
        {error && <span className="ui-error" role="alert">{error}</span>}
      </div>
      {phase === "not_installed" && harnessInstallUrl("codex") && (
        <button type="button" className="settings__action-button" onClick={() => rpc.send.openUrl({ url: harnessInstallUrl("codex")! })}>Install guide</button>
      )}
      {phase === "signed_out" && (
        <button type="button" className="settings__action-button" onClick={() => void signIn({ deviceCode: false })}>Sign in</button>
      )}
      {phase === "signing_in" && (
        <button type="button" className="settings__action-button" onClick={() => void cancel()}>Cancel</button>
      )}
      {phase === "signed_in" && (
        <button type="button" className="settings__action-button" onClick={() => void signOut()}>Sign out</button>
      )}
    </div>
  );
}

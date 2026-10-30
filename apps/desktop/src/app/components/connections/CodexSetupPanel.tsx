import { harnessInstallUrl } from "draft-core/harnesses";
import { useEffect, useRef } from "react";
import { useCodexConnection } from "../../hooks/useCodexConnection";
import { useFocusOnChange } from "../../hooks/useFocusOnChange";
import { rpc } from "../../rpc";
import { DeviceCodeSteps } from "./DeviceCodeSteps";

/** Shown on the start screen when Codex is picked but not ready: install it, then sign in, without leaving the page. */
export function CodexSetupPanel({ onStatusChange }: { onStatusChange: () => void }) {
  const { phase, device, error, starting, signIn, cancel } = useCodexConnection();
  const panel = useFocusOnChange<HTMLElement>(phase === "signing_in");
  const notify = useRef(onStatusChange);
  notify.current = onStatusChange;

  useEffect(() => {
    if (phase !== "loading") notify.current();
  }, [phase]);

  if (phase === "loading" || phase === "signed_in") return null;
  const installUrl = harnessInstallUrl("codex");

  return (
    <section ref={panel} tabIndex={-1} className="ui-start__setup" aria-label="Set up Codex" aria-live="polite">
      {phase === "not_installed" && (
        <>
          <p className="ui-start__setup-title">Codex is not installed</p>
          <p className="ui-muted">Install the Codex CLI, then come back to Draft. Draft finds it on its own.</p>
          <div className="ui-start__setup-actions">
            {installUrl && <button type="button" className="ui-btn ui-btn--primary" onClick={() => rpc.send.openUrl({ url: installUrl })}>Open install guide</button>}
          </div>
        </>
      )}
      {phase === "signed_out" && (
        <>
          <p className="ui-start__setup-title">Codex is installed. Sign in to use it.</p>
          <p className="ui-muted">Sign in with your ChatGPT account. Your ChatGPT plan works, and you do not need an API key.</p>
          <div className="ui-start__setup-actions">
            <button type="button" className="ui-btn ui-btn--primary" disabled={starting !== null} onClick={() => void signIn({ deviceCode: false })}>{starting === "browser" ? "Opening your browser…" : "Sign in with ChatGPT"}</button>
            <button type="button" className="ui-link" disabled={starting !== null} onClick={() => void signIn({ deviceCode: true })}>{starting === "code" ? "Getting a code…" : "Use a code instead"}</button>
          </div>
        </>
      )}
      {phase === "signing_in" && (
        <>
          <p className="ui-start__setup-title">{device ? "Finish signing in with a code" : "Finish signing in in your browser"}</p>
          {device && <DeviceCodeSteps url={device.url} code={device.code} />}
          <div className="ui-start__setup-actions">
            <button type="button" className="ui-btn" onClick={() => void cancel()}>Cancel</button>
          </div>
        </>
      )}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </section>
  );
}

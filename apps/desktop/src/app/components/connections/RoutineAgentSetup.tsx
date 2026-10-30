import type { RoutineAgentStatus } from "draft-shared-ui";
import { useFocusOnChange } from "../../hooks/useFocusOnChange";
import { useRoutineCodex } from "../../hooks/useRoutineCodex";
import { ClaudeTokenForm } from "./ClaudeTokenForm";
import { DeviceCodeSteps } from "./DeviceCodeSteps";

/** Shown in the new routine dialog when Codex is picked but not connected for routines: sign in without leaving the page. */
export function RoutineCodexSetup({ status, refresh }: { status: RoutineAgentStatus; refresh: () => void }) {
  const { phase, device, error, starting, connect, cancel } = useRoutineCodex(status, refresh);
  const panel = useFocusOnChange<HTMLElement>(phase === "signing_in");

  return (
    <section ref={panel} tabIndex={-1} className="ui-start__setup" aria-label="Connect Codex for routines" aria-live="polite">
      {phase === "signing_in" ? (
        <>
          <p className="ui-start__setup-title">{device ? "Finish signing in with a code" : "Finish signing in in your browser"}</p>
          {device && <DeviceCodeSteps url={device.url} code={device.code} />}
          <div className="ui-start__setup-actions">
            <button type="button" className="ui-btn" onClick={() => void cancel()}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="ui-start__setup-title">{status === "needs_reconnect" ? "Codex needs to be connected again" : "Connect Codex for routines"}</p>
          <p className="ui-muted">
            Routines run in Draft's cloud, so they need their own Codex login. Sign in with a ChatGPT account. It is separate from your own Codex login, and everyone in this workspace shares it.
          </p>
          <div className="ui-start__setup-actions">
            <button type="button" className="ui-btn ui-btn--primary" disabled={starting !== null} onClick={() => void connect({ deviceCode: false })}>{starting === "browser" ? "Opening your browser…" : "Sign in with ChatGPT"}</button>
            <button type="button" className="ui-link" disabled={starting !== null} onClick={() => void connect({ deviceCode: true })}>{starting === "code" ? "Getting a code…" : "Use a code instead"}</button>
          </div>
        </>
      )}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </section>
  );
}

/** Shown in the new routine dialog when Claude Code is picked but the workspace has no token for routines. */
export function RoutineClaudeSetup({ status, refresh }: { status: RoutineAgentStatus; refresh: () => void }) {
  return (
    <section className="ui-start__setup" aria-label="Connect Claude Code for routines" aria-live="polite">
      <p className="ui-start__setup-title">{status === "needs_reconnect" ? "Claude Code needs a new token" : "Connect Claude Code for routines"}</p>
      <p className="ui-muted">
        Routines run in Draft's cloud, so they need a Claude token. Run claude setup-token in a terminal, then paste the token here. Everyone in this workspace shares it.
      </p>
      <ClaudeTokenForm onSaved={refresh} />
    </section>
  );
}

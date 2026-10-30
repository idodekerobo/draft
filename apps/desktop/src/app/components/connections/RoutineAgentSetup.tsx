import type { RoutineAgentStatus } from "draft-shared-ui";
import { useRoutineCodex } from "../../hooks/useRoutineCodex";
import { rpc } from "../../rpc";
import { ClaudeTokenForm } from "./ClaudeTokenForm";

/** Shown in the new routine dialog when Codex is picked but not connected for routines: sign in without leaving the page. */
export function RoutineCodexSetup({ status, refresh }: { status: RoutineAgentStatus; refresh: () => void }) {
  const { phase, device, error, connect, cancel } = useRoutineCodex(status, refresh);

  return (
    <section className="ui-start__setup" aria-label="Connect Codex for routines">
      {phase === "signing_in" ? (
        <>
          <p className="ui-start__setup-title">{device ? "Open the link and enter this code" : "Finish signing in in your browser"}</p>
          {device && (
            <p>
              <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: device.url })}>{device.url}</button>
              {" "}
              <code aria-label="One-time code">{device.code}</code>
            </p>
          )}
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
            <button type="button" className="ui-btn ui-btn--primary" onClick={() => void connect({ deviceCode: false })}>Sign in with ChatGPT</button>
            <button type="button" className="ui-link" onClick={() => void connect({ deviceCode: true })}>Use a code instead</button>
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
    <section className="ui-start__setup" aria-label="Connect Claude Code for routines">
      <p className="ui-start__setup-title">{status === "needs_reconnect" ? "Claude Code needs a new token" : "Connect Claude Code for routines"}</p>
      <p className="ui-muted">
        Routines run in Draft's cloud, so they need a Claude token. Run claude setup-token in a terminal, then paste the token here. Everyone in this workspace shares it.
      </p>
      <ClaudeTokenForm onSaved={refresh} />
    </section>
  );
}

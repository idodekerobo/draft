"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIntegrationActions } from "./IntegrationActionsContext";
import { gmailErrorMessage, waitForGmailConnect } from "./gmail-connect";

export const GMAIL_PRIVACY_PROMISE = "Gmail stays private to you. Your agent reads it only when you ask. Draft stores nothing.";

interface GoogleConnectPanelProps {
  /** True when Google ended access (expired or revoked) and the person must sign in again. */
  needsReconnect?: boolean;
  onStatusRefresh: () => boolean | Promise<boolean>;
  onDone: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row" | "ui-panel";
  /** Extra controls under the connect button, for example Disconnect while a reconnect is needed. */
  children?: ReactNode;
}

export function GoogleConnectPanel({ needsReconnect = false, onStatusRefresh, onDone, classPrefix, children }: GoogleConnectPanelProps) {
  const { track, startGoogleConnect, pollGoogleConnect, openUrl } = useIntegrationActions();
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  async function connect() {
    setError(null);
    setPhase("starting");
    try {
      const start = await startGoogleConnect();
      if (!start.ok || !start.code || !start.authUrl) {
        setError(gmailErrorMessage(start.error, "Could not start the Google sign-in. Try again."));
        setPhase("idle");
        return;
      }
      setAuthUrl(start.authUrl);
      setPhase("waiting");
      await openUrl(start.authUrl);
      const code = start.code;
      const outcome = await waitForGmailConnect(() => pollGoogleConnect(code), { isCancelled: () => cancelled.current });
      if (outcome.status === "cancelled") return;
      if (outcome.status === "error") {
        setError(outcome.message);
        setPhase("idle");
        return;
      }
      track("integration_connected", { source: "gmail" });
      await onStatusRefresh();
      await onDone();
    } catch {
      if (cancelled.current) return;
      setError("Could not connect Gmail. Try again.");
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";
  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>{needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}</span>
      {needsReconnect && (
        <span className={`${classPrefix}__panel-help`}>Google ended Draft&apos;s access. Sign in again so your agent can read your Gmail.</span>
      )}
      <span className={`${classPrefix}__panel-help`}>{GMAIL_PRIVACY_PROMISE}</span>
      <span className={`${classPrefix}__panel-help`}>Access is read-only. Draft never sends, drafts, edits or deletes mail.</span>
      {phase === "waiting" && (
        <span className={`${classPrefix}__panel-help`} role="status">Finish signing in on the Google page in your browser.</span>
      )}
      {phase === "waiting" && authUrl && (
        <button type="button" className={`${classPrefix}__panel-link ${classPrefix}__panel-action`} onClick={() => void openUrl(authUrl)}>
          Google page did not open? Open it again
        </button>
      )}
      {error && <span className={`${classPrefix}__validation`} role="alert">{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={busy} aria-busy={busy}>
        {phase === "starting" ? "Opening Google…" : phase === "waiting" ? "Waiting for Google…" : needsReconnect ? "Reconnect with Google" : "Connect with Google"}
      </button>
      {children}
    </div>
  );
}

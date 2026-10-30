import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../rpc";

export type CodexPhase = "loading" | "not_installed" | "signed_out" | "signing_in" | "signed_in";

interface DeviceCode {
  url: string;
  code: string;
}

const POLL_MS = 2_000;
const LOGIN_LIMIT_MS = 15 * 60_000;

/** Whether Codex is installed and signed in here, with the actions to sign in and out. */
export function useCodexConnection() {
  const [phase, setPhase] = useState<CodexPhase>("loading");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    try {
      const status = await rpc.request.getCodexStatus();
      if (phaseRef.current === "signing_in" && status.auth !== "signed_in") return;
      setPhase(!status.installed ? "not_installed" : status.auth === "signed_in" ? "signed_in" : "signed_out");
      if (status.auth === "signed_in") setDevice(null);
    } catch {
      setPhase((current) => (current === "loading" ? "signed_out" : current));
    }
  }, []);

  // The person may install Codex or sign in in a terminal, so look again when they return to Draft.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Codex writes the login itself once the person finishes in the browser, so the app only watches for it.
  useEffect(() => {
    if (phase !== "signing_in") return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > LOGIN_LIMIT_MS) {
        void cancel();
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, refresh]);

  useEffect(() => () => {
    if (phaseRef.current === "signing_in") void rpc.request.cancelCodexLogin();
  }, []);

  async function signIn(options: { deviceCode: boolean }) {
    setError(null);
    setDevice(null);
    const result = await rpc.request.startCodexLogin(options).catch(() => ({ ok: false as const, error: "Could not start the sign-in." }));
    if (!result.ok) {
      setError(result.error);
      await refresh();
      return;
    }
    if (result.deviceUrl && result.deviceCode) setDevice({ url: result.deviceUrl, code: result.deviceCode });
    setPhase("signing_in");
  }

  async function cancel() {
    await rpc.request.cancelCodexLogin().catch(() => {});
    setDevice(null);
    setPhase("signed_out");
    await refresh();
  }

  async function signOut() {
    setError(null);
    const result = await rpc.request.codexLogout().catch(() => ({ ok: false as const, error: "Could not sign out of Codex." }));
    if (!result.ok) setError(result.error);
    await refresh();
  }

  return { phase, device, error, signIn, cancel, signOut };
}

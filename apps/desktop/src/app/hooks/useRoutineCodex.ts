import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../rpc";

export type RoutineCodexPhase = "loading" | "unknown" | "not_connected" | "connected" | "needs_reconnect" | "signing_in";

interface DeviceCode {
  url: string;
  code: string;
}

const POLL_MS = 2_000;
const LOGIN_LIMIT_MS = 15 * 60_000;

/** Whether the workspace's routines have a Codex login, with the actions to connect or reconnect one. */
export function useRoutineCodex() {
  const [phase, setPhase] = useState<RoutineCodexPhase>("loading");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    const result = await rpc.request.getRoutineCodexStatus().catch(() => null);
    if (phaseRef.current === "signing_in") return;
    if (!result || !result.ok) return setPhase("unknown");
    setPhase(result.status === null ? "not_connected" : result.status === "active" ? "connected" : "needs_reconnect");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cancel = useCallback(async () => {
    await rpc.request.cancelRoutineCodexLogin().catch(() => {});
    setDevice(null);
    setPhase("loading");
    await refresh();
  }, [refresh]);

  // The login finishes in the browser, so the app only watches for it.
  useEffect(() => {
    if (phase !== "signing_in") return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > LOGIN_LIMIT_MS) return void cancel();
      const result = await rpc.request.pollRoutineCodexLogin().catch(() => null);
      if (!result || result.state === "waiting") return;
      setDevice(null);
      if (result.state === "failed") setError(result.error);
      setPhase("loading");
      await refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase, cancel, refresh]);

  useEffect(() => () => {
    if (phaseRef.current === "signing_in") void rpc.request.cancelRoutineCodexLogin();
  }, []);

  async function connect(options: { deviceCode: boolean }) {
    setError(null);
    setDevice(null);
    const result = await rpc.request.startRoutineCodexLogin(options).catch(() => ({ ok: false as const, error: "Could not start the sign-in." }));
    if (!result.ok) return setError(result.error);
    if (result.deviceUrl && result.deviceCode) setDevice({ url: result.deviceUrl, code: result.deviceCode });
    setPhase("signing_in");
  }

  return { phase, device, error, connect, cancel };
}

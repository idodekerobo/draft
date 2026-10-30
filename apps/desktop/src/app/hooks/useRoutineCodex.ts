import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutineAgentStatus } from "draft-shared-ui";
import { rpc } from "../rpc";

export type RoutineCodexPhase = "loading" | RoutineAgentStatus | "signing_in";

interface DeviceCode {
  url: string;
  code: string;
}

const POLL_MS = 2_000;
const LOGIN_LIMIT_MS = 15 * 60_000;

/**
 * The actions to connect Codex for the workspace's routines. Whether it is connected comes from `status`,
 * and `onChanged` asks the caller to read that again after the login finishes or fails.
 */
export function useRoutineCodex(status: RoutineAgentStatus | undefined, onChanged: () => void) {
  const [signingIn, setSigningIn] = useState(false);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signingInRef = useRef(signingIn);
  signingInRef.current = signingIn;
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const phase: RoutineCodexPhase = signingIn ? "signing_in" : (status ?? "loading");

  const cancel = useCallback(async () => {
    await rpc.request.cancelRoutineCodexLogin().catch(() => {});
    setDevice(null);
    setSigningIn(false);
    changed.current();
  }, []);

  // The login finishes in the browser, so the app only watches for it.
  useEffect(() => {
    if (!signingIn) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > LOGIN_LIMIT_MS) return void cancel();
      const result = await rpc.request.pollRoutineCodexLogin().catch(() => null);
      if (!result || result.state === "waiting") return;
      if (result.state === "failed") setError(result.error);
      setDevice(null);
      setSigningIn(false);
      changed.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [signingIn, cancel]);

  useEffect(() => () => {
    if (signingInRef.current) void rpc.request.cancelRoutineCodexLogin();
  }, []);

  async function connect(options: { deviceCode: boolean }) {
    setError(null);
    setDevice(null);
    const result = await rpc.request.startRoutineCodexLogin(options).catch(() => ({ ok: false as const, error: "Could not start the sign-in." }));
    if (!result.ok) return setError(result.error);
    if (result.deviceUrl && result.deviceCode) setDevice({ url: result.deviceUrl, code: result.deviceCode });
    setSigningIn(true);
  }

  return { phase, device, error, connect, cancel };
}

import { useEffect, useRef, useState } from "react";
import { events, rpc } from "../rpc";

export type GithubInstallPhase = "idle" | "awaiting_approval" | "connected" | "error";

// Long-running background poll (not a single request/response like the
// static-token panels), so this mirrors useCloudSignIn's event-subscription
// + phaseRef unmount-cancel pattern rather than a plain async handler.
export function useGithubInstall(onConnected: () => void | Promise<void>) {
  const [phase, setPhase] = useState<GithubInstallPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => events.on("githubInstallProgress", ({ phase: nextPhase, error: nextError }) => {
    setPhase(nextPhase);
    setError(nextError ? nextError.replaceAll("_", " ") : null);
    if (nextPhase === "connected") void onConnected();
  }), [onConnected]);

  useEffect(() => () => {
    if (phaseRef.current === "awaiting_approval") void rpc.request.cancelGithubInstall();
  }, []);

  async function connect() {
    setError(null);
    setPhase("awaiting_approval");
    const result = await rpc.request.startGithubInstall();
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "Could not start GitHub install");
    }
  }

  return { phase, error, connect };
}

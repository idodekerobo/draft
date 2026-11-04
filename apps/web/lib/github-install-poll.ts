export type InstallSessionStatus =
  | { status: "pending" }
  | { status: "connected" }
  | { status: "error"; errorMessage?: string };

export type InstallPollResult =
  | { outcome: "connected" }
  | { outcome: "error"; message: string }
  | { outcome: "cancelled" };

export const INSTALL_POLL_INTERVAL_MS = 2_000;
// Matches the backend's install session lifetime.
export const INSTALL_POLL_TIMEOUT_MS = 5 * 60_000;

export interface InstallPollDeps {
  fetchStatus: () => Promise<InstallSessionStatus>;
  isCancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

const EXPIRED_MESSAGE = "The GitHub install timed out. Try again.";

/** Polls an install session until GitHub reports a result, the session expires, or the caller cancels. */
export async function pollInstallSession(deps: InstallPollDeps): Promise<InstallPollResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? INSTALL_POLL_TIMEOUT_MS;
  const started = now();

  while (true) {
    await sleep(intervalMs);
    if (deps.isCancelled()) return { outcome: "cancelled" };
    if (now() - started > timeoutMs) return { outcome: "error", message: EXPIRED_MESSAGE };
    try {
      const session = await deps.fetchStatus();
      if (deps.isCancelled()) return { outcome: "cancelled" };
      if (session.status === "connected") return { outcome: "connected" };
      if (session.status === "error") return { outcome: "error", message: session.errorMessage ?? "GitHub could not be connected. Try again." };
    } catch (error) {
      // A 404 means the session expired on the server; any other failure is treated as a blip and retried.
      if ((error as { status?: number }).status === 404) return { outcome: "error", message: EXPIRED_MESSAGE };
    }
  }
}

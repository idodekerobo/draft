export const HEARTBEAT_MS = 20_000;

/** Calls `send` now and then every interval, never two at once. Returns the stop function. */
export function startHeartbeat(send: () => Promise<void>, intervalMs = HEARTBEAT_MS): () => void {
  let busy = false;
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      await send();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  void beat();
  return () => clearInterval(timer);
}

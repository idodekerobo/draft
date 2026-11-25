export const HEARTBEAT_MS = 20_000;
/** A beat that runs longer than this is given up on, so one hung request cannot stop every later beat. */
export const HEARTBEAT_BEAT_TIMEOUT_MS = 30_000;

/** Calls `send` now and then every interval, never two at once. Returns the stop function. */
export function startHeartbeat(send: () => Promise<void>, intervalMs = HEARTBEAT_MS, beatTimeoutMs = HEARTBEAT_BEAT_TIMEOUT_MS): () => void {
  let busy = false;
  const beat = async () => {
    if (busy) return;
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        send(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, beatTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  void beat();
  return () => clearInterval(timer);
}

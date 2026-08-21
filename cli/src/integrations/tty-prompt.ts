import { closeSync, createReadStream, createWriteStream, openSync } from "fs";
import { createInterface, type Interface } from "readline/promises";

export type TtyConfirmResult = "yes" | "no" | "interrupted" | "unavailable";
export type TtyAckResult = "acked" | "timed_out" | "interrupted" | "unavailable";

async function withTty<T>(fn: (rl: Interface) => Promise<T>): Promise<T | "unavailable"> {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return "unavailable";
  }
  const input = createReadStream("/dev/null", { fd, autoClose: false });
  const output = createWriteStream("/dev/null", { fd, autoClose: false });
  try {
    const rl = createInterface({ input, output, terminal: true });
    try {
      return await fn(rl);
    } finally {
      rl.close();
    }
  } finally {
    input.destroy();
    output.destroy();
    try { closeSync(fd); } catch {}
  }
}

export async function ttyConfirm(message: string, signal?: AbortSignal): Promise<TtyConfirmResult> {
  if (signal?.aborted) return "interrupted";
  return withTty(async (rl) => {
    let answer: string;
    try {
      answer = (signal ? await rl.question(message, { signal }) : await rl.question(message)).trim().toLowerCase();
    } catch {
      if (signal?.aborted) return "interrupted";
      throw new Error("tty_prompt_failed");
    }
    if (signal?.aborted) return "interrupted";
    return answer === "y" || answer === "yes" ? "yes" : "no";
  });
}

// Resolves on Enter, on `timeoutMs` elapsing, or on `signal` aborting — all three are
// treated as "stop waiting", never as a hard failure; the caller decides what each means.
export async function ttyWaitForAck(message: string, timeoutMs: number, signal?: AbortSignal): Promise<TtyAckResult> {
  if (signal?.aborted) return "interrupted";
  return withTty(async (rl) => {
    const localController = new AbortController();
    const timeoutId = setTimeout(() => localController.abort(), timeoutMs);
    const onOuterAbort = () => localController.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      try {
        await rl.question(message, { signal: localController.signal });
        return "acked";
      } catch {
        if (signal?.aborted) return "interrupted";
        return "timed_out";
      }
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  });
}

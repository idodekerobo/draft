import type { WriteStream } from "fs";
import { finished } from "stream/promises";

// Flushing bytes already written to a local tty should be near-instant --
// this is only a safety bound, not something a stalled write should ever
// actually take. Never let cleanup itself become an unbounded hang.
const FLUSH_TIMEOUT_MS = 250;

// Flushes any write still in flight on `output` (readline writes to it
// internally -- rendering the prompt, echoing input -- independent of any
// writes the caller made directly) before the caller closes the underlying
// fd, so a pending write can't hit a closed fd. Bounded by a short timeout:
// this is teardown, not something that should ever be allowed to hang the
// process the way a stuck read could.
export async function flushTtyOutput(output: WriteStream): Promise<void> {
  output.end();
  // If the timeout branch wins, `finished(output)` is left pending -- give
  // it its own catch so that if it rejects later (e.g. because the caller
  // went on to close the fd anyway), it can't surface as an unhandled
  // rejection well after this function has already returned.
  const finishedPromise = finished(output);
  finishedPromise.catch(() => {});
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS));
  try {
    await Promise.race([finishedPromise, timeout]);
  } catch {}
}

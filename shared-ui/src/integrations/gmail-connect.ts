import type { GoogleConnectPoll } from "../types";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CONSECUTIVE_FAILURES = 5;

const GMAIL_ERROR_MESSAGES: Record<string, string> = {
  google_already_connected: "Gmail is already connected. Disconnect it first to connect a different account.",
  google_oauth_not_configured: "Google sign-in is not set up on this server yet.",
};

export function gmailErrorMessage(code: string | undefined, fallback: string): string {
  return (code && GMAIL_ERROR_MESSAGES[code]) || fallback;
}

export type GmailConnectOutcome =
  | { status: "connected" }
  | { status: "error"; message: string }
  | { status: "cancelled" };

/** Polls until the Google tab finishes, the connect fails, the user cancels, or time runs out. */
export async function waitForGmailConnect(
  poll: () => Promise<GoogleConnectPoll>,
  options: {
    isCancelled: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<GmailConnectOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + POLL_TIMEOUT_MS;
  let failures = 0;
  while (now() < deadline) {
    if (options.isCancelled()) return { status: "cancelled" };
    try {
      const result = await poll();
      failures = 0;
      if (result.status === "connected") return { status: "connected" };
      if (result.status === "error") {
        return { status: "error", message: result.message ?? "Could not connect Gmail. Try again." };
      }
    } catch {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return { status: "error", message: "Lost contact with Draft while connecting Gmail. Try again." };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: "error", message: "Gmail sign-in timed out. Try again." };
}

import {
  createGoogleConnectSession,
  pollGoogleConnectSession,
  type FetchResult,
  type GoogleConnectPoll,
  type GoogleConnectSession,
} from "../../cloud-client.ts";
import { browserLauncher, type BrowserLauncher } from "../browser.ts";
import type { IntegrationOutput } from "../safe-output.ts";

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10 * 60 * 1000;

export interface GoogleConnectOptions {
  noOpen: boolean;
}

export interface GoogleConnectDeps {
  createSession(signal: AbortSignal): Promise<FetchResult<GoogleConnectSession>>;
  poll(code: string, signal: AbortSignal): Promise<FetchResult<GoogleConnectPoll>>;
  launcher: BrowserLauncher;
  now(): number;
  sleep(ms: number): Promise<void>;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

const defaultDeps: GoogleConnectDeps = {
  createSession: createGoogleConnectSession,
  poll: pollGoogleConnectSession,
  launcher: browserLauncher,
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

export async function runGoogleConnect(
  options: GoogleConnectOptions,
  output: IntegrationOutput,
  deps: GoogleConnectDeps = defaultDeps,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  deps.onSignal("SIGINT", onSignal);
  deps.onSignal("SIGTERM", onSignal);

  try {
    const created = await deps.createSession(controller.signal);
    if (!created.ok) return output.error(created.code);

    const handoff = output.event({ status: "action_required", provider: "google", url: created.value.authUrl });
    if (handoff !== 0) return handoff;
    if (!options.noOpen) {
      await deps.launcher.launchBrowser(created.value.authUrl).catch(() => undefined);
    }

    const deadline = deps.now() + TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (controller.signal.aborted) return output.error("aborted");
      await deps.sleep(POLL_INTERVAL_MS);
      if (controller.signal.aborted) return output.error("aborted");
      const polled = await deps.poll(created.value.code, controller.signal);
      if (!polled.ok) return output.error(polled.code === "not_found" ? "expired" : polled.code);
      if (polled.value.status === "connected") return output.event({ status: "connected", provider: "google" });
      if (polled.value.status === "error") return output.error("poll_failed");
    }
    return output.error("timed_out");
  } finally {
    deps.offSignal("SIGINT", onSignal);
    deps.offSignal("SIGTERM", onSignal);
  }
}

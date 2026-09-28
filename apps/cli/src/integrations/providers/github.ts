import {
  GithubInstallPollError,
  pollGithubInstall,
  type GithubInstallPollResult,
} from "draft-core/github-install-poll";
import {
  createGithubInstallPollAdapter,
  createGithubInstallSession,
  type GithubInstallPollAdapter,
  type GithubInstallSession,
  type FetchResult,
} from "../../cloud-client.ts";
import { browserLauncher, type BrowserLauncher } from "../browser.ts";
import type { IntegrationOutput } from "../safe-output.ts";

export interface GithubConnectOptions {
  noOpen: boolean;
}

export interface GithubConnectDeps {
  createSession(signal: AbortSignal): Promise<FetchResult<GithubInstallSession>>;
  createPollAdapter(originWorkspaceId: string, code: string): GithubInstallPollAdapter;
  poll(input: Parameters<typeof pollGithubInstall>[0]): Promise<GithubInstallPollResult>;
  launcher: BrowserLauncher;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

const defaultDeps: GithubConnectDeps = {
  createSession: createGithubInstallSession,
  createPollAdapter: createGithubInstallPollAdapter,
  poll: pollGithubInstall,
  launcher: browserLauncher,
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

async function launchBrowserUntilAbort(
  launcher: BrowserLauncher,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      launcher.launchBrowser(url).then(() => undefined, () => undefined),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runGithubConnect(
  options: GithubConnectOptions,
  output: IntegrationOutput,
  deps: GithubConnectDeps = defaultDeps,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  deps.onSignal("SIGINT", onSignal);
  deps.onSignal("SIGTERM", onSignal);

  try {
    const created = await deps.createSession(controller.signal);
    if (!created.ok) return output.error(created.code);
    if (controller.signal.aborted) return output.error("aborted");

    const handoff = output.event({
      status: "browser_required",
      provider: "github",
      url: created.value.installUrl,
      expires_in_seconds: 300,
    });
    if (handoff !== 0) return handoff;
    if (!options.noOpen) {
      await launchBrowserUntilAbort(deps.launcher, created.value.installUrl, controller.signal);
    }
    if (controller.signal.aborted) return output.error("aborted");

    const awaitingInstall = output.event({ status: "awaiting_install", provider: "github" });
    if (awaitingInstall !== 0) return awaitingInstall;

    const adapter = deps.createPollAdapter(created.value.originWorkspaceId, created.value.code);
    try {
      const result = await deps.poll({
        apiUrl: "https://github-poll.invalid",
        workspaceId: created.value.originWorkspaceId,
        code: created.value.code,
        fetch: adapter.fetch,
        signal: controller.signal,
      });
      if (result.status === "connected") {
        return output.event({ status: "connected", provider: "github" });
      }
      return output.error(
        result.errorCode === "github_installation_conflict"
          ? "github_installation_conflict"
          : "poll_failed",
      );
    } catch (error) {
      const adapterFailure = adapter.failureCode();
      if (adapterFailure) return output.error(adapterFailure);
      if (error instanceof GithubInstallPollError) return output.error(error.kind);
      return output.error("poll_failed");
    }
  } finally {
    deps.offSignal("SIGINT", onSignal);
    deps.offSignal("SIGTERM", onSignal);
  }
}

// core/src/github-install-poll.ts — poll loop for the GitHub App install-session flow
//
// Used by: draft-desktop (main/auth/github-install.ts)
//
// Parallel to (not a refactor of) device-pairing.ts's pairDevice: same
// POLL_INTERVAL_MS/deadline/AbortSignal shape, but polls an already-created,
// already-authenticated install session rather than minting Draft auth
// tokens. Session creation and bearer-token attachment are the caller's job
// (this primitive only knows how to poll and interpret the result).

const POLL_INTERVAL_MS = 2_000;
const INSTALL_POLL_DEADLINE_MS = 300_000; // 5 minutes

export type GithubInstallPollResult =
  | { status: "connected" }
  | { status: "error"; message: string; errorCode?: string };

export interface GithubInstallPollDeps {
  apiUrl: string;
  workspaceId: string;
  code: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  /** Overridable for tests; defaults to POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Overridable for tests; defaults to INSTALL_POLL_DEADLINE_MS. */
  deadlineMs?: number;
  now?(): number;
}

export class GithubInstallPollError extends Error {
  constructor(
    public readonly kind: "expired" | "forbidden" | "timed_out" | "malformed_response" | "aborted" | "poll_failed",
  ) {
    super(kind);
    this.name = "GithubInstallPollError";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new GithubInstallPollError("aborted")); return; }
    const onAbort = () => {
      clearTimeout(id);
      reject(new GithubInstallPollError("aborted"));
    };
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchBeforeDeadline(
  deps: GithubInstallPollDeps,
  url: string,
  remainingMs: number,
): Promise<Response> {
  if (deps.signal.aborted) throw new GithubInstallPollError("aborted");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  deps.signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new GithubInstallPollError("timed_out"));
      }, remainingMs);
    });
    return await Promise.race([deps.fetch(url, { signal: controller.signal }), timeout]);
  } catch (error) {
    if (deps.signal.aborted) throw new GithubInstallPollError("aborted");
    if (timedOut || (error instanceof GithubInstallPollError && error.kind === "timed_out")) {
      throw new GithubInstallPollError("timed_out");
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    deps.signal.removeEventListener("abort", onAbort);
  }
}

export async function pollGithubInstall(deps: GithubInstallPollDeps): Promise<GithubInstallPollResult> {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? INSTALL_POLL_DEADLINE_MS;
  const deadline = now() + deadlineMs;

  while (now() < deadline) {
    const beforeSleep = deadline - now();
    try {
      await sleep(Math.min(pollIntervalMs, beforeSleep), deps.signal);
    } catch {
      throw new GithubInstallPollError("aborted");
    }
    if (now() >= deadline) throw new GithubInstallPollError("timed_out");

    let response: Response;
    try {
      response = await fetchBeforeDeadline(
        deps,
        `${deps.apiUrl}/workspaces/${encodeURIComponent(deps.workspaceId)}/github/install-sessions/${encodeURIComponent(deps.code)}`,
        deadline - now(),
      );
    } catch (error) {
      if (error instanceof GithubInstallPollError && error.kind === "timed_out") throw error;
      if (deps.signal.aborted) throw new GithubInstallPollError("aborted");
      throw new GithubInstallPollError("poll_failed");
    }

    if (response.status === 404) throw new GithubInstallPollError("expired");
    if (response.status === 403) throw new GithubInstallPollError("forbidden");
    if (!response.ok) throw new GithubInstallPollError("poll_failed");

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GithubInstallPollError("malformed_response");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GithubInstallPollError("malformed_response");
    }
    const body = value as { status?: unknown; errorMessage?: unknown; errorCode?: unknown };
    if (body.status === "pending") continue;
    if (body.status === "connected") return { status: "connected" };
    if (body.status === "error") {
      return {
        status: "error",
        message: typeof body.errorMessage === "string" ? body.errorMessage : "unknown_error",
        ...(typeof body.errorCode === "string" ? { errorCode: body.errorCode } : {}),
      };
    }
    throw new GithubInstallPollError("malformed_response");
  }

  throw new GithubInstallPollError("timed_out");
}

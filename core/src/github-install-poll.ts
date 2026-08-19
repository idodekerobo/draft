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
  | { status: "error"; message: string };

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
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(id); reject(new GithubInstallPollError("aborted")); }, { once: true });
  });
}

export async function pollGithubInstall(deps: GithubInstallPollDeps): Promise<GithubInstallPollResult> {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? INSTALL_POLL_DEADLINE_MS;
  const deadline = now() + deadlineMs;

  while (now() < deadline) {
    try {
      await sleep(pollIntervalMs, deps.signal);
    } catch {
      throw new GithubInstallPollError("aborted");
    }

    let response: Response;
    try {
      response = await deps.fetch(
        `${deps.apiUrl}/workspaces/${encodeURIComponent(deps.workspaceId)}/github/install-sessions/${encodeURIComponent(deps.code)}`,
        { signal: deps.signal },
      );
    } catch {
      if (deps.signal.aborted) throw new GithubInstallPollError("aborted");
      throw new GithubInstallPollError("poll_failed");
    }

    if (response.status === 404) throw new GithubInstallPollError("expired");
    if (response.status === 403) throw new GithubInstallPollError("forbidden");
    if (!response.ok) throw new GithubInstallPollError("poll_failed");

    const body = await response.json() as { status?: unknown; errorMessage?: unknown };
    if (body.status === "pending") continue;
    if (body.status === "connected") return { status: "connected" };
    if (body.status === "error") {
      return {
        status: "error",
        message: typeof body.errorMessage === "string" ? body.errorMessage : "unknown_error",
      };
    }
    throw new GithubInstallPollError("malformed_response");
  }

  throw new GithubInstallPollError("timed_out");
}

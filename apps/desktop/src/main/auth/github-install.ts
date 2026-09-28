import { getFreshAccessToken } from "draft-core/auth-state";
import { pollGithubInstall, GithubInstallPollError } from "draft-core/github-install-poll";

export interface GithubInstallEvents {
  openUrl(url: string): void;
  progress(value: { phase: "awaiting_approval" | "connected" | "error"; error?: string }): void;
}

function accessToken(): Promise<string> {
  return getFreshAccessToken({
    supabaseUrl: process.env.DRAFT_SUPABASE_URL ?? "",
    publishableKey: process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "",
  });
}

// Only two terminal phases (connected/error) -- setup_action: "request"
// (pending org-owner approval) surfaces as a plain "error" with the
// backend's message, per plans/draftv2/0047's Decision 3 (P0-1): v1 does
// not model a distinct pending-approval UI state.
export async function startGithubInstall(
  workspaceId: string,
  signal: AbortSignal,
  events: GithubInstallEvents,
): Promise<void> {
  const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";

  let code: string;
  let installUrl: string;
  try {
    const token = await accessToken();
    const response = await fetch(
      `${apiUrl}/workspaces/${encodeURIComponent(workspaceId)}/github/install-sessions`,
      { method: "POST", signal, headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`create_failed_${response.status}`);
    const body = await response.json() as { code?: unknown; installUrl?: unknown };
    if (typeof body.code !== "string" || typeof body.installUrl !== "string") {
      throw new Error("malformed_response");
    }
    code = body.code;
    installUrl = body.installUrl;
  } catch (error) {
    if (signal.aborted) return;
    events.progress({ phase: "error", error: error instanceof Error ? error.message : "create_failed" });
    return;
  }

  events.openUrl(installUrl);
  events.progress({ phase: "awaiting_approval" });

  // Cast: a plain wrapper function doesn't structurally match typeof fetch's
  // extra static `preconnect` member that Bun's global fetch carries.
  const authedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await accessToken();
    return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } });
  }) as typeof fetch;

  try {
    const result = await pollGithubInstall({ apiUrl, workspaceId, code, fetch: authedFetch, signal });
    if (result.status === "connected") {
      events.progress({ phase: "connected" });
    } else {
      events.progress({ phase: "error", error: result.message });
    }
  } catch (error) {
    if (signal.aborted) return;
    const message =
      error instanceof GithubInstallPollError ? error.kind : (error instanceof Error ? error.message : "poll_failed");
    events.progress({ phase: "error", error: message === "timed_out" ? "timed_out" : message });
  }
}

// core/src/integrations/github-oauth.ts — GitHub Device Flow join-team flow
//
// Used by: draft-desktop (native "join a team" onboarding step)
//
// Two entry points:
//   startGitHubDeviceFlow — full device-code request -> poll -> verify-access
//     -> completeJoin sequence. Fire-and-forget: the caller's RPC handler
//     returns almost immediately, all real progress (including the
//     multi-minute wait for browser authorization) arrives via onProgress.
//   resumePendingJoin — restart-safe retry: re-runs verifyRepoAccess +
//     completeJoin against an already-issued token (LocalConfig.pending_join),
//     no new device code needed.
//
// completeJoin writes collaboration.json/local.json before the join is
// "done" and only clears pending_join on full success, so a crash mid-stage
// still leaves a resumable pending_join on the next launch.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  readIntegrations,
  readLocalConfig,
  readSecrets,
  writeCollaboration,
  writeIntegrations,
  writeLocalConfig,
  writeSecrets,
  type Integrations,
} from "../config";
import {
  parseGitHubRepoUrl,
  promoteStagedTeamContent,
  stageTeamContent,
  verifyRepoAccess,
} from "../sync/team-load";

export { parseGitHubRepoUrl };

// ── logging ─────────────────────────────────────────────────────────────────
//
// Same central-log convention as publish.ts/team-load.ts — one file per
// module under ~/.draft/logs/. Never logs tokens, repo URLs, or usernames.

const LOG_FILE = join(homedir(), ".draft", "logs", "github-oauth.log");

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [github-oauth] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const OAUTH_SCOPE = "repo";

export type DeviceFlowPhase = "awaiting_user" | "verifying_access" | "complete" | "error";

export type DeviceFlowErrorCode =
  | "expired" | "denied" | "device_flow_disabled" | "no_access"
  | "network" | "rate_limited" | "unknown";

export interface DeviceFlowProgress {
  phase: DeviceFlowPhase;
  userCode?: string;
  verificationUri?: string;
  label: string;
  error?: string;
  errorCode?: DeviceFlowErrorCode;
  /**
   * Only meaningful when phase === "error". True once LocalConfig.pending_join
   * has actually been written (i.e. a token was issued) — the point past
   * which a retry should call resumePendingJoin rather than starting a new
   * device flow. False for failures that happen before that point (invalid
   * URL, missing client id, a device-code request or poll that never
   * produced a token), where there is nothing to resume.
   */
  resumable?: boolean;
}

export type StartDeviceFlowResult = { ok: true } | { ok: false; error: string };

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

// ── per-workspace cancellation ───────────────────────────────────────────────

const activeFlows = new Map<string, AbortController>();

export function cancelActiveDeviceFlow(workspace: string): void {
  activeFlows.get(workspace)?.abort();
  activeFlows.delete(workspace);
}

function deviceFlowErrorLabel(code: DeviceFlowErrorCode): string {
  switch (code) {
    case "expired": return "This code expired. Start over to get a new one.";
    case "denied": return "Sign-in was cancelled.";
    case "device_flow_disabled": return "Your GitHub organization has disabled device sign-in for this app.";
    case "network": return "Network error during sign-in. Try again.";
    case "rate_limited": return "GitHub rate-limited this request. Try again shortly.";
    case "no_access": return "No access yet — ask your team to add you to the GitHub org, then try again.";
    default: return "Something went wrong during GitHub sign-in.";
  }
}

// ── device code request + polling ─────────────────────────────────────────────

async function requestDeviceCode(clientId: string, signal: AbortSignal): Promise<DeviceCodeResponse | null> {
  try {
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: OAUTH_SCOPE }),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DeviceCodeResponse;
  } catch {
    return null;
  }
}

type PollOutcome =
  | { ok: true; token: string }
  | { ok: false; errorCode: DeviceFlowErrorCode; cancelled?: boolean; description?: string };

async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  signal: AbortSignal,
): Promise<PollOutcome> {
  let interval = intervalSeconds;
  const deadline = Date.now() + expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) return { ok: false, errorCode: "unknown", cancelled: true };
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    if (signal.aborted) return { ok: false, errorCode: "unknown", cancelled: true };

    let res: Response;
    try {
      res = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      });
    } catch {
      return { ok: false, errorCode: "network" };
    }

    let body: TokenPollResponse;
    try {
      body = (await res.json()) as TokenPollResponse;
    } catch {
      return { ok: false, errorCode: "unknown" };
    }

    if (body.access_token) return { ok: true, token: body.access_token };

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5; // per GitHub's documented behavior
        continue;
      case "expired_token":
        return { ok: false, errorCode: "expired", description: body.error_description };
      case "access_denied":
        return { ok: false, errorCode: "denied", description: body.error_description };
      case "device_flow_disabled":
        return { ok: false, errorCode: "device_flow_disabled", description: body.error_description };
      default:
        return { ok: false, errorCode: "unknown", description: body.error_description ?? body.error };
    }
  }

  return { ok: false, errorCode: "expired" };
}

async function fetchGitHubLogin(token: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: string };
    return body.login;
  } catch {
    return undefined;
  }
}

// ── completeJoin ───────────────────────────────────────────────────────────────

export async function completeJoin(
  workspace: string,
  profile: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  onProgress: (p: DeviceFlowProgress) => void,
): Promise<StartDeviceFlowResult> {
  onProgress({ phase: "verifying_access", label: "Downloading team context…" });

  const collabPath = join(workspace, "config", "collaboration.json");
  const localPath = join(workspace, "config", "local.json");
  const integPath = join(workspace, "config", "integrations.json");
  const collabPrior = existsSync(collabPath) ? readFileSync(collabPath, "utf8") : null;
  const localPrior = existsSync(localPath) ? readFileSync(localPath, "utf8") : null;
  const integPrior = existsSync(integPath) ? readFileSync(integPath, "utf8") : null;

  writeCollaboration(workspace, {
    mode: "github",
    team_repo_url: `https://github.com/${owner}/${repo}`,
    team_repo_subdir: "root",
  });
  // pending_join is NOT cleared here — only sync_method/default_branch are
  // set now, the join is not "done" yet. See below: it's only cleared once
  // stage+promote fully succeed, so a crash in between leaves a resumable
  // pending_join on the next launch instead of a half-configured workspace.
  writeLocalConfig(workspace, { sync_method: "github-api", default_branch: defaultBranch });

  const rollbackConfig = () => {
    if (collabPrior !== null) writeFileSync(collabPath, collabPrior); else rmSync(collabPath, { force: true });
    if (localPrior !== null) writeFileSync(localPath, localPrior); else rmSync(localPath, { force: true });
    if (integPrior !== null) writeFileSync(integPath, integPrior); else rmSync(integPath, { force: true });
  };

  log(`complete-join: owner=${owner} repo=${repo} — staging team content`);
  const staged = await stageTeamContent({ workspace, profile });
  if (!staged.ok) {
    log(`complete-join: stage failed — error=${staged.error} — config rolled back`);
    rollbackConfig();
    onProgress({
      phase: "error",
      errorCode: staged.error === "rate_limited" ? "rate_limited" : "unknown",
      label: "Couldn't download team context.",
      error: staged.error,
      // pending_join was already written by the caller before completeJoin
      // ran (and rollbackConfig only reverts collaboration.json/local.json's
      // sync_method+default_branch, not pending_join itself) — still resumable.
      resumable: true,
    });
    return { ok: false, error: staged.error };
  }

  const promoted = await promoteStagedTeamContent(staged.staged.operationId);
  if (!promoted.ok) {
    log(`complete-join: promote failed — error=${promoted.error} — config rolled back`);
    rollbackConfig();
    onProgress({ phase: "error", errorCode: "unknown", label: "Couldn't apply team context.", error: promoted.error, resumable: true });
    return { ok: false, error: promoted.error };
  }

  // Only now — full success — clear pending_join and mark the gh-CLI-parity
  // integration state connected, so Settings/StatusBar show "connected"
  // correctly for a native-OAuth-joined user without a separate gh-CLI prompt.
  writeLocalConfig(workspace, { pending_join: undefined });
  const existingIntegrations = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existingIntegrations.ok ? existingIntegrations.integrations : {}),
    github: { connected: true, via: "oauth-device-flow", last_connected: new Date().toISOString() },
  } as Integrations);

  log(`complete-join: success — owner=${owner} repo=${repo}`);
  onProgress({ phase: "complete", label: "You're all set." });
  return { ok: true };
}

// ── startGitHubDeviceFlow ────────────────────────────────────────────────────

export interface StartDeviceFlowOpts {
  repoUrl: string;
  workspace: string;
  profile: string;
  onProgress: (p: DeviceFlowProgress) => void;
}

export async function startGitHubDeviceFlow(opts: StartDeviceFlowOpts): Promise<void> {
  const { repoUrl, workspace, profile, onProgress } = opts;

  if (activeFlows.has(workspace)) {
    log(`start: rejected — a flow is already active for this workspace`);
    onProgress({ phase: "error", errorCode: "unknown", label: "A GitHub sign-in is already in progress.", resumable: false });
    return;
  }

  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    log(`start: rejected — could not parse repo URL`);
    onProgress({ phase: "error", errorCode: "unknown", label: "Enter a valid GitHub URL, e.g. https://github.com/owner/repo.", resumable: false });
    return;
  }

  const clientId = process.env.DRAFT_GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    log(`start: rejected — no client id baked into this build`);
    onProgress({ phase: "error", errorCode: "unknown", label: "GitHub join isn't available in this build.", resumable: false });
    return;
  }

  log(`start: owner=${parsed.owner} repo=${parsed.repo}`);
  const controller = new AbortController();
  activeFlows.set(workspace, controller);

  try {
    const deviceCode = await requestDeviceCode(clientId, controller.signal);
    if (!deviceCode) {
      if (controller.signal.aborted) return;
      log(`start: device code request failed — network error`);
      onProgress({ phase: "error", errorCode: "network", label: "Couldn't start GitHub sign-in. Check your connection and try again.", resumable: false });
      return;
    }

    log(`start: device code issued, awaiting user`);
    onProgress({
      phase: "awaiting_user",
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      label: "Enter this code on GitHub to continue.",
    });

    const poll = await pollForToken(clientId, deviceCode.device_code, deviceCode.interval, deviceCode.expires_in, controller.signal);
    if (!poll.ok) {
      if (poll.cancelled) {
        log(`start: cancelled during poll`);
        return;
      }
      log(`start: poll failed — errorCode=${poll.errorCode}${poll.description ? ` description=${poll.description}` : ""}`);
      // No token was ever issued — nothing in pending_join to resume.
      onProgress({ phase: "error", errorCode: poll.errorCode, label: deviceFlowErrorLabel(poll.errorCode), error: poll.description, resumable: false });
      return;
    }

    const login = await fetchGitHubLogin(poll.token);
    writeSecrets(workspace, { github_oauth_token: poll.token, github_oauth_login: login });
    writeLocalConfig(workspace, {
      pending_join: { team_repo_url: repoUrl, owner: parsed.owner, repo: parsed.repo },
    });
    log(`start: token issued, pending_join written`);

    onProgress({ phase: "verifying_access", label: "Checking repository access…" });
    const access = await verifyRepoAccess(poll.token, parsed.owner, parsed.repo);
    if (!access.ok) {
      const errorCode: DeviceFlowErrorCode = access.reason === "unknown" ? "unknown" : access.reason;
      // Status code + owner/repo are logged inside verifyRepoAccess itself
      // (~/.draft/logs/team-load.log) — this line just marks where the join
      // flow stopped and that it's resumable.
      log(`start: verifyRepoAccess failed — reason=${access.reason} — pending_join left in place, resumable`);
      // pending_join was just written above — resumable via resumePendingJoin, no new device code.
      onProgress({ phase: "error", errorCode, label: deviceFlowErrorLabel(errorCode), resumable: true });
      return;
    }

    log(`start: access verified, completing join`);
    await completeJoin(workspace, profile, parsed.owner, parsed.repo, access.defaultBranch, onProgress);
  } finally {
    activeFlows.delete(workspace);
  }
}

// ── resumePendingJoin ─────────────────────────────────────────────────────────
//
// Restart-safe retry: re-runs verifyRepoAccess + completeJoin against the
// token already stored in secrets.json. No new device code needed unless the
// token itself has been revoked (surfaced as a normal completeJoin failure).

export interface ResumePendingJoinOpts {
  workspace: string;
  profile: string;
  onProgress: (p: DeviceFlowProgress) => void;
}

export async function resumePendingJoin(opts: ResumePendingJoinOpts): Promise<void> {
  const { workspace, profile, onProgress } = opts;

  if (activeFlows.has(workspace)) {
    log(`resume: rejected — a flow is already active for this workspace`);
    onProgress({ phase: "error", errorCode: "unknown", label: "A GitHub sign-in is already in progress.", resumable: false });
    return;
  }

  const localResult = readLocalConfig(workspace);
  const pending = localResult.ok ? localResult.config.pending_join : undefined;
  if (!pending) {
    log(`resume: rejected — no pending_join in local.json`);
    onProgress({ phase: "error", errorCode: "unknown", label: "No pending join to resume.", resumable: false });
    return;
  }
  const secretsResult = readSecrets(workspace);
  const token = secretsResult.ok ? secretsResult.secrets.github_oauth_token : undefined;
  if (!token) {
    log(`resume: rejected — no github_oauth_token in secrets.json`);
    onProgress({ phase: "error", errorCode: "unknown", label: "GitHub sign-in expired. Start over.", resumable: false });
    return;
  }

  log(`resume: owner=${pending.owner} repo=${pending.repo}`);

  // Shares activeFlows with startGitHubDeviceFlow so a concurrent call from
  // either entry point is rejected above rather than racing. There's no
  // device-code poll to cancel here, but an AbortController still lets a
  // concurrent cancelActiveDeviceFlow() call cut the network requests below.
  const controller = new AbortController();
  activeFlows.set(workspace, controller);

  try {
    onProgress({ phase: "verifying_access", label: "Checking repository access…" });
    const access = await verifyRepoAccess(token, pending.owner, pending.repo);
    if (!access.ok) {
      const errorCode: DeviceFlowErrorCode = access.reason === "unknown" ? "unknown" : access.reason;
      // Status code is logged inside verifyRepoAccess itself (~/.draft/logs/team-load.log).
      log(`resume: verifyRepoAccess failed — reason=${access.reason} — pending_join left in place, resumable`);
      // pending_join is still there — this failure is itself resumable.
      onProgress({ phase: "error", errorCode, label: deviceFlowErrorLabel(errorCode), resumable: true });
      return;
    }

    log(`resume: access verified, completing join`);
    await completeJoin(workspace, profile, pending.owner, pending.repo, access.defaultBranch, onProgress);
  } finally {
    activeFlows.delete(workspace);
  }
}

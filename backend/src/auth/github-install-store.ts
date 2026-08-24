import { randomBytes } from "node:crypto";

export interface GithubInstallSessionResult {
  status: "connected" | "error";
  errorCode?: string;
  errorMessage?: string;
}

interface PendingInstallSession {
  workspaceId: string;
  createdAt: number;
  result?: GithubInstallSessionResult;
}

export type InstallSessionState =
  | { status: "pending"; workspaceId: string }
  | { status: "expired_or_unknown" }
  | { status: "connected" | "error"; workspaceId: string; errorCode?: string; errorMessage?: string };

const TTL_MS = 5 * 60 * 1000;
let now = () => Date.now();
let pending = new Map<string, PendingInstallSession>();

function sweepExpired(): void {
  const currentTime = now();
  for (const [code, entry] of pending) {
    if (currentTime - entry.createdAt >= TTL_MS) pending.delete(code);
  }
}

// Intentionally process-local for only one long lived server, same caveat
// as pairing-store.ts: replace with shared storage/redis before scaling
// horizontally. 128-bit code (vs. pairing's ~40-bit) since this poll route
// has no second-factor approval step gating it the way pairing does.
export function createInstallSession(workspaceId: string): string {
  sweepExpired();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomBytes(16).toString("hex");
    if (!pending.has(code)) {
      pending.set(code, { workspaceId, createdAt: now() });
      return code;
    }
  }
  throw new Error("unable_to_allocate_install_session_code");
}

// The first terminal result wins; later callbacks cannot overwrite it.
export function resolveInstallSession(code: string, result: GithubInstallSessionResult): boolean {
  sweepExpired();
  const entry = pending.get(code);
  if (!entry || entry.result) return false;
  entry.result = result;
  return true;
}

// Returns workspaceId even while pending so the callback route (which has
// no other way to learn it) can bind its verify/upsert to the right
// workspace. The caller -- not this function -- is responsible for
// rejecting a mismatch against the URL's :id (the workspace-binding check
// belongs in the route, since the callback route legitimately reads across
// workspaces while the poll route must not).
export function getInstallSession(code: string): InstallSessionState {
  sweepExpired();
  const entry = pending.get(code);
  if (!entry) return { status: "expired_or_unknown" };
  if (!entry.result) return { status: "pending", workspaceId: entry.workspaceId };
  return {
    status: entry.result.status,
    workspaceId: entry.workspaceId,
    ...(entry.result.errorCode ? { errorCode: entry.result.errorCode } : {}),
    ...(entry.result.errorMessage ? { errorMessage: entry.result.errorMessage } : {}),
  };
}

export function resetInstallSessionStore(clock: () => number = () => Date.now()): void {
  pending = new Map();
  now = clock;
}

export function getInstallSessionStoreSizeForTests(): number {
  return pending.size;
}

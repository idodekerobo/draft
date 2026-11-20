import { randomBytes } from "node:crypto";

export interface GoogleOAuthSessionResult {
  status: "connected" | "error";
  errorCode?: string;
  errorMessage?: string;
}

interface PendingGoogleOAuthSession {
  workspaceId: string;
  userId: string;
  codeVerifier: string;
  createdAt: number;
  result?: GoogleOAuthSessionResult;
}

export type GoogleOAuthSessionState =
  | { status: "expired_or_unknown" }
  | { status: "pending"; workspaceId: string; userId: string; codeVerifier: string }
  | {
      status: "connected" | "error";
      workspaceId: string;
      userId: string;
      errorCode?: string;
      errorMessage?: string;
    };

const TTL_MS = 10 * 60 * 1000;
let now = () => Date.now();
let pending = new Map<string, PendingGoogleOAuthSession>();

function sweepExpired(): void {
  const currentTime = now();
  for (const [state, entry] of pending) {
    if (currentTime - entry.createdAt >= TTL_MS) pending.delete(state);
  }
}

// Process-local like github-install-store.ts: replace with shared storage
// before scaling the backend horizontally.
export function createGoogleOAuthSession(workspaceId: string, userId: string, codeVerifier: string): string {
  sweepExpired();
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = randomBytes(16).toString("hex");
    if (!pending.has(state)) {
      pending.set(state, { workspaceId, userId, codeVerifier, createdAt: now() });
      return state;
    }
  }
  throw new Error("unable_to_allocate_google_oauth_state");
}

// The first terminal result wins; a replayed callback cannot overwrite it.
export function resolveGoogleOAuthSession(state: string, result: GoogleOAuthSessionResult): boolean {
  sweepExpired();
  const entry = pending.get(state);
  if (!entry || entry.result) return false;
  entry.result = result;
  return true;
}

export function getGoogleOAuthSession(state: string): GoogleOAuthSessionState {
  sweepExpired();
  const entry = pending.get(state);
  if (!entry) return { status: "expired_or_unknown" };
  if (!entry.result) {
    return {
      status: "pending",
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      codeVerifier: entry.codeVerifier,
    };
  }
  return {
    status: entry.result.status,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    ...(entry.result.errorCode ? { errorCode: entry.result.errorCode } : {}),
    ...(entry.result.errorMessage ? { errorMessage: entry.result.errorMessage } : {}),
  };
}

export function resetGoogleOAuthSessionStore(clock: () => number = () => Date.now()): void {
  pending = new Map();
  now = clock;
}

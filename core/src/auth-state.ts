import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { DRAFT_ROOT } from "./config";

export interface AuthState {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  organization_id: string | null;
  team_id: string | null;
  workspace_id: string | null;
  /** True only after the account/workspace identity has been resolved by /whoami. */
  identity_resolved: boolean;
  /**
   * Server-side timestamp of when this user finished the desktop onboarding
   * wizard, or null. Per-user (not per-workspace) since many users can
   * share a workspace and each still needs their own device-level setup —
   * see the users.onboarding_completed_at migration's comment.
   */
  onboarding_completed_at: string | null;
}
const PERSONAL_DIR = join(DRAFT_ROOT, "personal");
const AUTH_FILE = join(PERSONAL_DIR, "auth.json");
const CLI_AUTH_FILE = join(PERSONAL_DIR, "cli-auth.json");

export function normalizeAuthState(value: Partial<AuthState>): AuthState | null {
  return typeof value.access_token === "string" && typeof value.refresh_token === "string" && typeof value.expires_at === "number"
    ? {
        access_token: value.access_token,
        refresh_token: value.refresh_token,
        expires_at: value.expires_at,
        organization_id: value.organization_id ?? null,
        team_id: value.team_id ?? null,
        workspace_id: value.workspace_id ?? null,
        // Legacy auth files predate identity hydration and must be recovered.
        identity_resolved: value.identity_resolved === true,
        onboarding_completed_at: value.onboarding_completed_at ?? null,
      }
    : null;
}

export interface AuthStateStore {
  read(): AuthState | null;
  write(state: AuthState): void;
  clear(): void;
}

/**
 * Builds an isolated read/write/clear store bound to one credential file.
 * Desktop and CLI each get their own file — neither may read, overwrite,
 * refresh, or clear the other's store.
 */
export function createAuthStateStore(filePath: string): AuthStateStore {
  const read = (): AuthState | null => {
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AuthState>;
      return normalizeAuthState(value);
    } catch {
      // Missing or corrupt credential JSON is treated as unauthenticated
      // without exposing its contents.
      return null;
    }
  };
  const write = (state: AuthState): void => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    // Unique per-writer temp name so concurrent writers never collide.
    const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch {}
    renameSync(temporary, filePath);
    try { chmodSync(filePath, 0o600); } catch {}
  };
  const clear = (): void => {
    try { unlinkSync(filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  return { read, write, clear };
}

const desktopStore = createAuthStateStore(AUTH_FILE);
export const readAuthState = desktopStore.read;
export const writeAuthState = desktopStore.write;
export const clearAuthState = desktopStore.clear;

const cliStore = createAuthStateStore(CLI_AUTH_FILE);
export const readCliAuthState = cliStore.read;
export const writeCliAuthState = cliStore.write;
export const clearCliAuthState = cliStore.clear;

/** Returns the cached workspace identity without a network request. */
export function getCachedWorkspaceId(): string | null {
  return readAuthState()?.workspace_id ?? null;
}

// ── Cross-process refresh lock ──────────────────────────────────────────────
//
// Supabase rotates refresh tokens on every use, so two processes racing to
// refresh the same stale refresh_token would have the loser fail with
// "already used". A same-directory lock file (exclusive create) serializes
// refreshes across processes sharing one credential file.

const LOCK_MAX_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30_000;

export class AuthLockError extends Error {
  constructor() {
    super("auth_busy");
    this.name = "AuthLockError";
  }
}

export async function acquireFileLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        continue; // lock was removed between the failed create and this stat — retry now
      }
    }
    if (Date.now() >= deadline) throw new AuthLockError();
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

// ── Access token refresh ────────────────────────────────────────────────────

export interface AccessTokenProviderDeps {
  read(): AuthState | null;
  write(state: AuthState): void;
  fetch(input: string, init: RequestInit): Promise<Response>;
  /**
   * Optional cross-process lock. When provided, the refresh critical
   * section is guarded by it and credentials are reloaded after
   * acquisition in case another process already refreshed.
   */
  acquireLock?(): Promise<() => void>;
}

export class AuthRefreshError extends Error {
  constructor(public readonly kind: "terminal" | "transient") {
    super(`session_refresh_${kind}`);
    this.name = "AuthRefreshError";
  }
}

export function createAccessTokenProvider(deps: AccessTokenProviderDeps) {
  let inFlightRefresh: Promise<string> | null = null;
  return async function accessToken(options: { supabaseUrl: string; publishableKey: string; now?: () => number; forceRefresh?: boolean }): Promise<string> {
    const state = deps.read();
    if (!state) throw new Error("not_signed_in");
    const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
    if (!options.forceRefresh && state.expires_at > nowSeconds + 60) return state.access_token;
    if (inFlightRefresh) return inFlightRefresh;

    inFlightRefresh = (async () => {
      let releaseLock: (() => void) | null = null;
      try {
        if (deps.acquireLock) releaseLock = await deps.acquireLock();

        // Reload after acquiring the lock — another process may have
        // already refreshed while we were waiting.
        const current0 = deps.read() ?? state;
        if (!options.forceRefresh && current0.expires_at > nowSeconds + 60) return current0.access_token;

        let response: Response;
        try {
          response = await deps.fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { apikey: options.publishableKey, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: current0.refresh_token }),
          });
        } catch {
          throw new AuthRefreshError("transient");
        }
        if (!response.ok) {
          const terminal = response.status === 400 || response.status === 401 || response.status === 403;
          throw new AuthRefreshError(terminal ? "terminal" : "transient");
        }
        const body = await response.json() as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
        if (!body.access_token || !body.refresh_token) throw new AuthRefreshError("transient");
        const refreshed = {
          ...current0,
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: body.expires_at ?? nowSeconds + (body.expires_in ?? 3600),
        };
        const current = deps.read();
        if (!current || current.refresh_token !== current0.refresh_token) throw new Error("auth_state_changed");
        deps.write(refreshed);
        return refreshed.access_token;
      } finally {
        releaseLock?.();
        inFlightRefresh = null;
      }
    })();

    return inFlightRefresh;
  };
}

const defaultAccessTokenProvider = createAccessTokenProvider({
  read: readAuthState,
  write: writeAuthState,
  fetch: (input, init) => fetch(input, init),
  acquireLock: () => acquireFileLock(`${AUTH_FILE}.lock`),
});
export const getFreshAccessToken = defaultAccessTokenProvider;

const cliAccessTokenProvider = createAccessTokenProvider({
  read: readCliAuthState,
  write: writeCliAuthState,
  fetch: (input, init) => fetch(input, init),
  acquireLock: () => acquireFileLock(`${CLI_AUTH_FILE}.lock`),
});
export const getFreshCliAccessToken = cliAccessTokenProvider;

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
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

export function readAuthState(): AuthState | null {
  try {
    const value = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Partial<AuthState>;
    return normalizeAuthState(value);
  } catch { return null; }
}

/** Returns the cached workspace identity without a network request. */
export function getCachedWorkspaceId(): string | null {
  return readAuthState()?.workspace_id ?? null;
}
export function writeAuthState(state: AuthState): void {
  mkdirSync(PERSONAL_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${AUTH_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, AUTH_FILE);
  try { chmodSync(AUTH_FILE, 0o600); } catch {}
}

export function clearAuthState(): void {
  try { unlinkSync(AUTH_FILE); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Supabase rotates refresh tokens on every use, so two concurrent refresh
// calls sharing the same stale refresh_token would race — the second to
// land gets "already used" and fails. Callers that fan out several fetches
// at once (e.g. getContextFiles fetching N documents in parallel) all hit
// this within the same tick, so a single in-flight refresh is shared
// instead of each caller firing its own request.
export interface AccessTokenProviderDeps {
  read(): AuthState | null;
  write(state: AuthState): void;
  fetch(input: string, init: RequestInit): Promise<Response>;
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
      try {
        let response: Response;
        try {
          response = await deps.fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { apikey: options.publishableKey, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: state.refresh_token }),
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
          ...state,
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: body.expires_at ?? nowSeconds + (body.expires_in ?? 3600),
        };
        const current = deps.read();
        if (!current || current.refresh_token !== state.refresh_token) throw new Error("auth_state_changed");
        deps.write(refreshed);
        return refreshed.access_token;
      } finally {
        inFlightRefresh = null;
      }
    })();

    return inFlightRefresh;
  };
}

const defaultAccessTokenProvider = createAccessTokenProvider({ read: readAuthState, write: writeAuthState, fetch: (input, init) => fetch(input, init) });
export const getFreshAccessToken = defaultAccessTokenProvider;

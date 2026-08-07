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
}
const PERSONAL_DIR = join(DRAFT_ROOT, "personal");
const AUTH_FILE = join(PERSONAL_DIR, "auth.json");

export function readAuthState(): AuthState | null {
  try {
    const value = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Partial<AuthState>;
    return typeof value.access_token === "string" && typeof value.refresh_token === "string" && typeof value.expires_at === "number"
      ? {
          access_token: value.access_token,
          refresh_token: value.refresh_token,
          expires_at: value.expires_at,
          organization_id: value.organization_id ?? null,
          team_id: value.team_id ?? null,
          workspace_id: value.workspace_id ?? null,
        }
      : null;
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
let inFlightRefresh: Promise<string> | null = null;

export async function getFreshAccessToken(options: { supabaseUrl: string; publishableKey: string; now?: () => number }): Promise<string> {
  const state = readAuthState();
  if (!state) throw new Error("not_signed_in");
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (state.expires_at > nowSeconds + 60) return state.access_token;
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    try {
      const response = await fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: options.publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: state.refresh_token }),
      });
      if (!response.ok) throw new Error("session_refresh_failed");
      const body = await response.json() as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
      if (!body.access_token || !body.refresh_token) throw new Error("invalid_refresh_response");
      const refreshed = {
        ...state,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: body.expires_at ?? nowSeconds + (body.expires_in ?? 3600),
      };
      writeAuthState(refreshed);
      return refreshed.access_token;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

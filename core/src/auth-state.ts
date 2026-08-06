import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { DRAFT_ROOT } from "./config";

export interface AuthState {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
const PERSONAL_DIR = join(DRAFT_ROOT, "personal");
const AUTH_FILE = join(PERSONAL_DIR, "auth.json");

export function readAuthState(): AuthState | null {
  try {
    const value = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Partial<AuthState>;
    return typeof value.access_token === "string" && typeof value.refresh_token === "string" && typeof value.expires_at === "number" ? value as AuthState : null;
  } catch { return null; }
}
export function writeAuthState(state: AuthState): void {
  mkdirSync(PERSONAL_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${AUTH_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, AUTH_FILE);
  try { chmodSync(AUTH_FILE, 0o600); } catch {}
}

export async function getFreshAccessToken(options: { supabaseUrl: string; publishableKey: string; now?: () => number }): Promise<string> {
  const state = readAuthState();
  if (!state) throw new Error("not_signed_in");
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (state.expires_at > nowSeconds + 60) return state.access_token;
  const response = await fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: options.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.refresh_token }),
  });
  if (!response.ok) throw new Error("session_refresh_failed");
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
  if (!body.access_token || !body.refresh_token) throw new Error("invalid_refresh_response");
  const refreshed = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at ?? nowSeconds + (body.expires_in ?? 3600) };
  writeAuthState(refreshed);
  return refreshed.access_token;
}

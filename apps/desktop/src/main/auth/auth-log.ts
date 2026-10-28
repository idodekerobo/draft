import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { AuthRefreshError, readAuthState } from "draft-core/auth-state";

const LOG_FILE = `${process.env.HOME}/.draft/logs/desktop-auth.log`;

export type ClearPath = "session_check" | "identity_hydrate" | "api_call" | "user_sign_out";

export interface ClearDetail {
  error?: unknown;
  whoamiStatus?: number;
  apiStatus?: number;
}

function sessionIdOf(accessToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken?.split(".")[1] ?? "", "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** One log line that explains why the login was cleared. It holds no token, email or response body. */
export function buildLoginClearedEntry(path: ClearPath, detail: ClearDetail, accessToken: string | undefined, now: Date = new Date()) {
  const refresh = detail.error instanceof AuthRefreshError ? detail.error : null;
  const reason = refresh ? refresh.code : detail.error instanceof Error ? detail.error.message : undefined;
  return {
    timestamp: now.toISOString(),
    event: "login_cleared",
    path,
    refreshStatus: refresh?.status ?? null,
    reason: reason ?? null,
    whoamiStatus: detail.whoamiStatus ?? null,
    apiStatus: detail.apiStatus ?? null,
    sessionId: sessionIdOf(accessToken),
  };
}

/** Call before clearing the login, while the session id can still be read. It never throws. */
export function logLoginCleared(path: ClearPath, detail: ClearDetail = {}): void {
  try {
    const entry = buildLoginClearedEntry(path, detail, readAuthState()?.access_token);
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

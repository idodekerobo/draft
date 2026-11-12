import type { AuthState } from "draft-core/auth-state";
import type { SessionExpiredCause } from "../server/server-client";
import type { ClearDetail } from "./auth-log";

export interface SessionExpiredDeps {
  read(): AuthState | null;
  clear(): void;
  log(path: "api_call", detail: ClearDetail): void;
  notifySignedOut(): void;
}

/**
 * Signs the user out once. Calls that were already in flight find no login left to clear,
 * so they stay quiet instead of writing one log line each.
 */
export function createSessionExpiredHandler(deps: SessionExpiredDeps) {
  return (cause: SessionExpiredCause): void => {
    if (!deps.read()) return;
    deps.log("api_call", cause);
    try { deps.clear(); } catch {}
    deps.notifySignedOut();
  };
}

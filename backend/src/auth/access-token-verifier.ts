import type { VerifiedCaller } from "./verify";

/** Tries the local check first. Only a token it rejects reaches the remote check. */
export function createAccessTokenVerifier(deps: {
  verifyLocal: (token: string) => Promise<string | null>;
  verifyRemote: (token: string) => Promise<string | null>;
}): (accessToken: string) => Promise<VerifiedCaller | null> {
  return async (accessToken) => {
    if (!accessToken) return null;
    const userId = (await deps.verifyLocal(accessToken)) ?? (await deps.verifyRemote(accessToken));
    return userId ? { userId, accessToken } : null;
  };
}

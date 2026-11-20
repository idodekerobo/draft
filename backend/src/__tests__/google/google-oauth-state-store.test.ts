import { beforeEach, describe, expect, it } from "bun:test";
import {
  createGoogleOAuthSession,
  getGoogleOAuthSession,
  resetGoogleOAuthSessionStore,
  resolveGoogleOAuthSession,
} from "../../auth/google-oauth-state-store";

describe("google oauth state store", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000;
    resetGoogleOAuthSessionStore(() => clock);
  });

  it("binds state to workspace, user and PKCE verifier", () => {
    const state = createGoogleOAuthSession("ws-1", "user-1", "verifier");
    expect(getGoogleOAuthSession(state)).toEqual({
      status: "pending",
      workspaceId: "ws-1",
      userId: "user-1",
      codeVerifier: "verifier",
    });
  });

  it("keeps the first terminal result", () => {
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    expect(resolveGoogleOAuthSession(state, { status: "connected" })).toBe(true);
    expect(resolveGoogleOAuthSession(state, { status: "error", errorCode: "x" })).toBe(false);
    expect(getGoogleOAuthSession(state).status).toBe("connected");
  });

  it("expires after the TTL and rejects unknown state", () => {
    const state = createGoogleOAuthSession("ws-1", "user-1", "v");
    clock += 10 * 60 * 1000;
    expect(getGoogleOAuthSession(state).status).toBe("expired_or_unknown");
    expect(getGoogleOAuthSession("nope").status).toBe("expired_or_unknown");
  });
});

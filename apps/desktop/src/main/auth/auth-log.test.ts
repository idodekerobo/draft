import { describe, expect, test } from "bun:test";
import { AuthRefreshError } from "draft-core/auth-state";
import { buildLoginClearedEntry } from "./auth-log";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const at = new Date("2026-10-28T12:00:00Z");

describe("buildLoginClearedEntry", () => {
  test("records the provider's status and code for a failed refresh, with the session id", () => {
    const entry = buildLoginClearedEntry("session_check", { error: new AuthRefreshError("terminal", 400, "refresh_token_already_used") }, jwt({ session_id: "sess-1" }), at);
    expect(entry).toEqual({
      timestamp: "2026-10-28T12:00:00.000Z", event: "login_cleared", path: "session_check",
      refreshStatus: 400, reason: "refresh_token_already_used", whoamiStatus: null, apiStatus: null, sessionId: "sess-1",
    });
  });
  test("uses the error message when there is no refresh error", () => {
    expect(buildLoginClearedEntry("identity_hydrate", { error: new Error("not_signed_in") }, undefined, at)).toMatchObject({ refreshStatus: null, reason: "not_signed_in", sessionId: null });
  });
  test("records the status of a rejected call", () => {
    expect(buildLoginClearedEntry("identity_hydrate", { whoamiStatus: 403 }, undefined, at)).toMatchObject({ whoamiStatus: 403, reason: null });
    expect(buildLoginClearedEntry("api_call", { apiStatus: 401 }, undefined, at)).toMatchObject({ apiStatus: 401 });
  });
  test("a user sign-out carries no failure detail", () => {
    expect(buildLoginClearedEntry("user_sign_out", {}, jwt({ session_id: "s" }), at)).toMatchObject({ refreshStatus: null, reason: null, whoamiStatus: null, apiStatus: null });
  });
  test("never includes the token itself", () => {
    const token = jwt({ session_id: "s", email: "someone@example.test" });
    expect(JSON.stringify(buildLoginClearedEntry("api_call", {}, token, at))).not.toContain("someone@example.test");
  });
  test("returns a null session id for a malformed token", () => {
    expect(buildLoginClearedEntry("api_call", {}, "not-a-jwt", at).sessionId).toBeNull();
  });
});

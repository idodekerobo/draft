import { describe, expect, test } from "bun:test";
import type { AuthState } from "draft-core/auth-state";
import { createSessionExpiredHandler } from "./session-expired";

const signedIn: AuthState = { access_token: "a", refresh_token: "r", expires_at: 1, organization_id: null, team_id: null, workspace_id: null, identity_resolved: true, onboarding_completed_at: null };

function setup(initial: AuthState | null) {
  let value = initial;
  const calls = { logged: [] as unknown[], notified: 0, cleared: 0 };
  const handler = createSessionExpiredHandler({
    read: () => value,
    clear: () => { calls.cleared++; value = null; },
    log: (_path, detail) => { calls.logged.push(detail); },
    notifySignedOut: () => { calls.notified++; },
  });
  return { handler, calls, value: () => value };
}

describe("session expired handler", () => {
  test("logs, clears and tells the window once", () => {
    const t = setup(signedIn);
    t.handler({ apiStatus: 401 });
    expect(t.calls).toEqual({ logged: [{ apiStatus: 401 }], notified: 1, cleared: 1 });
    expect(t.value()).toBeNull();
  });

  test("calls that were in flight when the login was cleared stay quiet", () => {
    const t = setup(signedIn);
    t.handler({ apiStatus: 401 });
    for (let i = 0; i < 40; i++) t.handler({ error: new Error("not_signed_in") });
    expect(t.calls).toEqual({ logged: [{ apiStatus: 401 }], notified: 1, cleared: 1 });
  });

  test("does nothing when there was no login to begin with", () => {
    const t = setup(null);
    t.handler({ error: new Error("not_signed_in") });
    expect(t.calls).toEqual({ logged: [], notified: 0, cleared: 0 });
  });

  test("still tells the window when clearing the file fails", () => {
    const calls = { notified: 0 };
    const handler = createSessionExpiredHandler({ read: () => signedIn, clear: () => { throw new Error("EPERM"); }, log: () => {}, notifySignedOut: () => { calls.notified++; } });
    handler({});
    expect(calls.notified).toBe(1);
  });
});

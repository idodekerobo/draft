import { describe, expect, test } from "bun:test";
import { createIdentityHydrator, hydrateUserIdentity, TransientIdentityError, type IdentityDeps } from "./user-identity";
import { AuthRefreshError, type AuthState } from "draft-core/auth-state";

const state = (resolved = false): AuthState => ({ access_token: "a", refresh_token: "r", expires_at: 9e9, organization_id: "o", team_id: "t", workspace_id: "w", identity_resolved: resolved, onboarding_completed_at: null });
function deps(initial: AuthState | null, responses: Response[] = []) {
  let value = initial; const calls: boolean[] = [];
  const result: IdentityDeps & { calls: boolean[] } = { calls, read: () => value, write: (v) => { value = v; }, clear: () => { value = null; }, token: async (force) => { calls.push(force); return force ? "b" : "a"; }, fetchWhoami: async () => responses.shift()! };
  return result;
}

describe("hydrateUserIdentity", () => {
  test("missing auth is hydrated signed-out", async () => { expect(await hydrateUserIdentity(deps(null))).toMatchObject({ signedIn: false, hydrated: true }); });
  test("uses complete cache without network", async () => { const d = deps(state(true)); expect((await hydrateUserIdentity(d)).workspaceId).toBe("w"); expect(d.calls).toEqual([]); });
  test("authoritative null workspace is cached as resolved", async () => { const d = deps(state(), [Response.json({ organization_id: "x", primary_team_id: null, workspace_id: null })]); expect(await hydrateUserIdentity(d)).toMatchObject({ signedIn: true, hydrated: true, workspaceId: null }); expect(d.read()?.identity_resolved).toBe(true); });
  test("recovers unresolved identity", async () => { const d = deps(state(), [Response.json({ organization_id: "x", primary_team_id: "y", workspace_id: "z" })]); expect((await hydrateUserIdentity(d)).workspaceId).toBe("z"); expect(d.calls).toEqual([false]); });
  test("forces one refresh and retry on unauthorized", async () => { const d = deps(state(), [new Response(null, { status: 401 }), Response.json({ workspace_id: "z" })]); await hydrateUserIdentity(d); expect(d.calls).toEqual([false, true]); });
  test("clears terminal unauthorized", async () => { const d = deps(state(), [new Response(null, { status: 403 }), new Response(null, { status: 401 })]); expect((await hydrateUserIdentity(d)).signedIn).toBe(false); });
  test("surfaces provider failures as transient", async () => { const d = deps(state(), [new Response(null, { status: 503 })]); expect(hydrateUserIdentity(d)).rejects.toBeInstanceOf(TransientIdentityError); });
  test("terminal token error clears auth", async () => { const d = deps(state()); d.token = async () => { throw new AuthRefreshError("terminal"); }; expect((await hydrateUserIdentity(d)).signedIn).toBe(false); expect(d.read()).toBeNull(); });
  test("transient token error preserves auth", async () => { const d = deps(state()); d.token = async () => { throw new AuthRefreshError("transient"); }; expect(hydrateUserIdentity(d)).rejects.toBeInstanceOf(TransientIdentityError); expect(d.read()).not.toBeNull(); });
  test("does not overwrite a newer session", async () => {
    const old = state(); let value: AuthState | null = old;
    const d: IdentityDeps = { read: () => value, write: (v) => { value = v; }, clear: () => { value = null; }, token: async () => "a", fetchWhoami: async () => { value = { ...state(true), refresh_token: "new", workspace_id: "new" }; return Response.json({ workspace_id: "old" }); } };
    expect((await hydrateUserIdentity(d)).workspaceId).toBe("new");
  });
  test("deduplicates concurrent hydration", async () => {
    let release!: (value: Response) => void; const response = new Promise<Response>((resolve) => { release = resolve; }); let calls = 0;
    const d = deps(state()); d.fetchWhoami = async () => { calls++; return response; }; const hydrate = createIdentityHydrator(d);
    const first = hydrate(); const second = hydrate(); expect(calls).toBe(0); await Promise.resolve(); expect(calls).toBe(1);
    release(Response.json({ workspace_id: "z" })); expect(await Promise.all([first, second])).toHaveLength(2); expect(calls).toBe(1);
  });
});

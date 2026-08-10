import { describe, expect, test } from "bun:test";
import { createAccessTokenProvider, normalizeAuthState, type AuthState } from "../auth-state";

const auth = (overrides: Partial<AuthState> = {}): AuthState => ({ access_token: "old", refresh_token: "refresh", expires_at: 10, organization_id: "org", team_id: "team", workspace_id: "workspace", identity_resolved: true, onboarding_completed_at: null, ...overrides });
function harness(initial = auth(), fetcher: (calls: number) => Promise<Response> = async () => Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 60 })) {
  let value: AuthState | null = initial; let calls = 0;
  const token = createAccessTokenProvider({ read: () => value, write: (next) => { value = next; }, fetch: async () => fetcher(++calls) });
  return { token, value: () => value, calls: () => calls };
}
const options = { supabaseUrl: "https://example.test", publishableKey: "key", now: () => 20_000 };

describe("auth state", () => {
  test("legacy auth is unresolved", () => { expect(normalizeAuthState({ access_token: "a", refresh_token: "r", expires_at: 1 })?.identity_resolved).toBe(false); });
  test("forced refresh bypasses a fresh token and preserves resolved identity while rotating tokens", async () => {
    const h = harness(auth({ expires_at: 999 }));
    expect(await h.token({ ...options, now: () => 0, forceRefresh: true })).toBe("new");
    expect(h.calls()).toBe(1); expect(h.value()).toMatchObject({ refresh_token: "rotated", identity_resolved: true, workspace_id: "workspace" });
  });
  test.each([400, 401, 403])("classifies %s as terminal", async (status) => { const h = harness(auth(), async () => new Response(null, { status })); expect(h.token(options)).rejects.toThrow("session_refresh_terminal"); });
  test.each([429, 500, 503])("classifies %s as transient", async (status) => { const h = harness(auth(), async () => new Response(null, { status })); expect(h.token(options)).rejects.toThrow("session_refresh_transient"); });
  test("classifies network failure as transient", async () => { const h = harness(auth(), async () => { throw new Error("offline"); }); expect(h.token(options)).rejects.toThrow("session_refresh_transient"); });
  test("shares one in-flight refresh", async () => {
    let release!: (response: Response) => void; const pending = new Promise<Response>((resolve) => { release = resolve; });
    const h = harness(auth(), async () => pending); const first = h.token(options); const second = h.token(options);
    expect(h.calls()).toBe(1); release(Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 60 }));
    expect(await Promise.all([first, second])).toEqual(["new", "new"]); expect(h.calls()).toBe(1);
  });
});
